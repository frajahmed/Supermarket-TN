import { ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { RequestContext } from '../auth/request-context';
import { DbService } from '../db/db.service';
import { assertStoreAccess } from '../inventory/inventory.controller';
import { DevicePatch } from './devices.dto';

const COLUMNS = `
  d.id, d.name, d.kind, d.store_id AS "storeId", s.name AS "storeName", d.first_seen_at AS "firstSeenAt",
  d.last_seen_at AS "lastSeenAt", u.display_name AS "lastUserName", d.revoked_at AS "revokedAt"`;

@Injectable()
export class DevicesService {
  constructor(private readonly db: DbService) {}

  async list(ctx: RequestContext) {
    return this.db.withTenant(ctx, async (db) => {
      const r = await db.query<{ id: string }>(
        `SELECT ${COLUMNS} FROM app.devices d
           LEFT JOIN app.stores s ON s.id = d.store_id LEFT JOIN app.users u ON u.id = d.last_user_id
          ORDER BY d.revoked_at IS NOT NULL, d.last_seen_at DESC NULLS LAST`);
      return { items: r.rows.map((d) => ({ ...d, isCurrent: d.id === ctx.deviceId })) };
    });
  }

  async update(ctx: RequestContext, id: string, b: DevicePatch) {
    if (b.storeId) assertStoreAccess(ctx, b.storeId);
    if (b.storeId === null && ctx.role !== 'owner') {
      throw new ForbiddenException('Nur der Inhaber kann ein Gerät von der Filiale lösen');
    }
    return this.db.withTenant(ctx, async (db) => {
      await this.require(db, id);
      const sets: string[] = [];
      const values: unknown[] = [id];
      if (b.name !== undefined) { values.push(b.name); sets.push(`name = $${values.length}`); }
      if (b.storeId !== undefined) { values.push(b.storeId); sets.push(`store_id = $${values.length}`); }
      await db.query(`UPDATE app.devices SET ${sets.join(', ')} WHERE id = $1`, values);
      await db.query(
        `INSERT INTO app.audit_log (tenant_id, user_id, action, entity_type, entity_id, after)
         VALUES ($1, $2, 'device.update', 'device', $3, $4::jsonb)`, [ctx.tenantId, ctx.userId, id, JSON.stringify(b)]);
      return this.require(db, id);
    });
  }

  async revoke(ctx: RequestContext, id: string) {
    if (id === ctx.deviceId) throw new ConflictException('Das eigene, gerade benutzte Gerät kann nicht gesperrt werden');
    return this.db.withTenant(ctx, async (db) => {
      const d = await this.require(db, id);
      if (d.revokedAt) return d;
      await db.query('SELECT app.revoke_device($1)', [id]);
      return this.require(db, id);
    });
  }

  private async require(db: PoolClient, id: string) {
    const r = await db.query<{ id: string; revokedAt: Date | null }>(
      `SELECT ${COLUMNS} FROM app.devices d
         LEFT JOIN app.stores s ON s.id = d.store_id LEFT JOIN app.users u ON u.id = d.last_user_id
        WHERE d.id = $1`, [id]);
    if (!r.rows[0]) throw new NotFoundException('Gerät nicht gefunden');
    return r.rows[0];
  }
}
