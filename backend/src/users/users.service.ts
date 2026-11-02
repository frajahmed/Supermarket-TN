import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { hashSecret } from '../../../shared/license-core.ts';
import { hasPermission } from '../auth/permissions';
import { AuthFlowProvider } from '../auth/auth.module-providers';
import { RequestContext, UserRole } from '../auth/request-context';
import { encryptTotpSecret } from '../core/totp.ts';
import { DbService } from '../db/db.service';
import { UserCreate, UserPatch } from './users.dto';

type UserRow = {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  locale: string | null;
  isActive: boolean;
  totpConfigured: boolean;
  storeIds: string[];
  createdAt: Date;
  updatedAt: Date;
};

const USER_COLUMNS = `
  u.id, u.email::text AS email, u.display_name AS "displayName", u.role,
  u.locale, u.is_active AS "isActive", (u.totp_secret_enc IS NOT NULL) AS "totpConfigured",
  COALESCE(array_agg(usa.store_id) FILTER (WHERE usa.store_id IS NOT NULL), '{}') AS "storeIds",
  u.created_at AS "createdAt", u.updated_at AS "updatedAt"`;

function isUniqueError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: string }).code === '23505';
}

@Injectable()
export class UsersService {
  constructor(private readonly db: DbService, private readonly auth: AuthFlowProvider) {}

  async list(ctx: RequestContext): Promise<{ items: UserRow[] }> {
    return this.db.withTenant(ctx, async (db) => ({
      items: (await db.query<UserRow>(this.userQuery(ctx, false), this.userParams(ctx, false))).rows,
    }));
  }

  async create(ctx: RequestContext, body: UserCreate): Promise<UserRow> {
    this.assertRoleCanManage(ctx, body.role);
    this.assertTotpRole(body.role, body.totpSecret);
    if ((body.role === 'owner' || body.role === 'manager') && body.password === undefined) {
      throw new BadRequestException('Für Inhaber und Filialleiter ist ein Passwort erforderlich');
    }
    const passwordHash = body.password === undefined ? null : await hashSecret(body.password);
    const pinHash = body.pin === undefined ? null : await hashSecret(body.pin);
    const totpSecretEnc = body.totpSecret === undefined
      ? null : encryptTotpSecret(body.totpSecret, this.auth.totpKey);

    return this.db.withTenant(ctx, async (db) => {
      await this.validateStores(db, ctx, body.storeIds);
      try {
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO app.users
             (tenant_id, email, display_name, role, password_hash, pin_hash, locale, is_active, totp_secret_enc)
           VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8)
           RETURNING id`,
          [ctx.tenantId, body.email.trim().toLowerCase(), body.displayName, body.role,
           passwordHash, pinHash, body.locale ?? null, totpSecretEnc],
        );
        const userId = inserted.rows[0].id;
        await this.replaceStores(db, ctx.tenantId, userId, body.storeIds);
        await this.audit(db, ctx, 'user.create', userId, { role: body.role, isActive: true });
        return this.requireVisibleUser(db, ctx, userId);
      } catch (error: unknown) {
        if (isUniqueError(error)) throw new ConflictException('E-Mail ist im Mandanten bereits vergeben');
        throw error;
      }
    });
  }

  async update(ctx: RequestContext, userId: string, body: UserPatch): Promise<UserRow> {
    return this.db.withTenant(ctx, async (db) => {
      const before = await this.requireVisibleUser(db, ctx, userId);
      const effectiveRole = body.role ?? before.role;
      this.assertRoleCanManage(ctx, effectiveRole);
      this.assertTotpRole(effectiveRole, body.totpSecret);
      await this.validateStores(db, ctx, body.storeIds ?? before.storeIds);

      const values: unknown[] = [];
      const assignments: string[] = [];
      const add = (column: string, value: unknown) => {
        assignments.push(`${column} = $${values.length + 2}`);
        values.push(value);
      };
      if (body.displayName !== undefined) add('display_name', body.displayName);
      if (body.role !== undefined) add('role', body.role);
      if (body.password !== undefined) add('password_hash', body.password === null ? null : await hashSecret(body.password));
      if (body.pin !== undefined) add('pin_hash', body.pin === null ? null : await hashSecret(body.pin));
      if (body.locale !== undefined) add('locale', body.locale);
      if (body.isActive !== undefined) add('is_active', body.isActive);
      if (body.totpSecret !== undefined) {
        add('totp_secret_enc', body.totpSecret === null ? null : encryptTotpSecret(body.totpSecret, this.auth.totpKey));
      }

      try {
        if (assignments.length > 0) {
          await db.query(`UPDATE app.users SET ${assignments.join(', ')} WHERE id = $1`, [userId, ...values]);
        }
        if (body.storeIds !== undefined) await this.replaceStores(db, ctx.tenantId, userId, body.storeIds);
        if (body.isActive === false) {
          await db.query(
            `UPDATE app.refresh_tokens SET revoked_at = coalesce(revoked_at, now())
              WHERE tenant_id = $1 AND user_id = $2 AND revoked_at IS NULL`,
            [ctx.tenantId, userId],
          );
        }
        await this.audit(db, ctx, body.isActive === false ? 'user.deactivate' : 'user.update', userId, {
          role: effectiveRole, isActive: body.isActive ?? before.isActive,
        });
        return this.requireVisibleUser(db, ctx, userId);
      } catch (error: unknown) {
        if (isUniqueError(error)) throw new ConflictException('E-Mail ist im Mandanten bereits vergeben');
        throw error;
      }
    });
  }

  private assertRoleCanManage(ctx: RequestContext, targetRole: UserRole): void {
    if (hasPermission(ctx.role, 'user.manage.all')) return;
    if (targetRole !== 'stock_clerk' && targetRole !== 'cashier') {
      throw new ForbiddenException('Filialleiter dürfen nur Lageristen und Kassierer verwalten');
    }
  }

  private assertTotpRole(role: UserRole, secret: string | null | undefined): void {
    if (secret !== undefined && role !== 'owner' && role !== 'manager') {
      throw new BadRequestException('TOTP ist nur für Inhaber und Filialleiter verfügbar');
    }
  }

  private async validateStores(db: PoolClient, ctx: RequestContext, storeIds: string[]): Promise<void> {
    const ids = [...new Set(storeIds)];
    if (ids.length !== storeIds.length) throw new BadRequestException('Filialen dürfen nicht doppelt zugewiesen werden');
    if (ids.length === 0) return;
    if (!hasPermission(ctx.role, 'user.manage.all') && ids.some((id) => !ctx.storeIds.includes(id))) {
      throw new ForbiddenException('Eine Filiale liegt außerhalb Ihres Zuständigkeitsbereichs');
    }
    const result = await db.query<{ id: string }>('SELECT id FROM app.stores WHERE id = ANY($1::uuid[])', [ids]);
    if (result.rows.length !== ids.length) throw new ForbiddenException('Filiale nicht gefunden oder nicht zugänglich');
  }

  private async replaceStores(db: PoolClient, tenantId: string, userId: string, storeIds: string[]): Promise<void> {
    await db.query('DELETE FROM app.user_store_access WHERE tenant_id = $1 AND user_id = $2', [tenantId, userId]);
    if (storeIds.length > 0) {
      await db.query(
        `INSERT INTO app.user_store_access (tenant_id, user_id, store_id)
         SELECT $1, $2, unnest($3::uuid[])`, [tenantId, userId, storeIds],
      );
    }
  }

  private userQuery(ctx: RequestContext, single: boolean): string {
    const allUsers = hasPermission(ctx.role, 'user.manage.all');
    const scope = allUsers
      ? 'u.tenant_id = $1'
      : `u.tenant_id = $1 AND u.role IN ('stock_clerk', 'cashier')
         AND EXISTS (SELECT 1 FROM app.user_store_access scoped
                      WHERE scoped.tenant_id = u.tenant_id AND scoped.user_id = u.id
                        AND scoped.store_id = ANY($2::uuid[]))`;
    const idClause = single ? ` AND u.id = $${allUsers ? 2 : 3}` : '';
    return `SELECT ${USER_COLUMNS} FROM app.users u
      LEFT JOIN app.user_store_access usa ON usa.tenant_id = u.tenant_id AND usa.user_id = u.id
      WHERE ${scope}${idClause}
      GROUP BY u.id ORDER BY u.email`;
  }

  private userParams(ctx: RequestContext, single: boolean, userId?: string): unknown[] {
    if (hasPermission(ctx.role, 'user.manage.all')) return single ? [ctx.tenantId, userId] : [ctx.tenantId];
    return single ? [ctx.tenantId, ctx.storeIds, userId] : [ctx.tenantId, ctx.storeIds];
  }

  private async requireVisibleUser(db: PoolClient, ctx: RequestContext, userId: string): Promise<UserRow> {
    const result = await db.query<UserRow>(this.userQuery(ctx, true), this.userParams(ctx, true, userId));
    if (!result.rows[0]) {
      if (!hasPermission(ctx.role, 'user.manage.all')) {
        const sameTenant = await db.query<{ id: string }>(
          'SELECT id FROM app.users WHERE tenant_id = $1 AND id = $2', [ctx.tenantId, userId]);
        if (sameTenant.rows[0]) throw new ForbiddenException('Benutzer liegt außerhalb Ihres Zuständigkeitsbereichs');
      }
      throw new NotFoundException('Benutzer nicht gefunden');
    }
    return result.rows[0];
  }

  private async audit(db: PoolClient, ctx: RequestContext, action: string, userId: string, after: object): Promise<void> {
    await db.query(
      `INSERT INTO app.audit_log (tenant_id, user_id, action, entity_type, entity_id, after)
       VALUES ($1, $2, $3, 'user', $4, $5::jsonb)`,
      [ctx.tenantId, ctx.userId, action, userId, JSON.stringify(after)],
    );
  }
}
