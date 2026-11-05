import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { AuthFlowProvider } from '../auth/auth.module-providers';
import { permissionsFor } from '../auth/permissions';
import { LicensingService } from '../licensing/licensing.service';
import { RequestContext } from '../auth/request-context';
import {
  decryptTotpSecret, encryptTotpSecret, generateTotpSecret, matchingTotpStep, totpUri,
} from '../core/totp.ts';
import { DbService } from '../db/db.service';

/** Ausstehende Einrichtung verfällt nach 15 Minuten. */
const PENDING_TTL_SECONDS = 15 * 60;
const TOTP_ROLES = new Set(['owner', 'manager']);

/**
 * 2FA-Einrichtung durch den Nutzer selbst (T-108):
 * 1. setup   – Server erzeugt das Geheimnis, speichert es verschlüsselt als ausstehend
 *              und zeigt es genau einmal (QR-Code über otpauth-URI).
 * 2. confirm – erst ein gültiger Code aus der Authenticator-App macht es aktiv.
 * Niemand außer dem Nutzer selbst bekommt das Geheimnis je zu sehen.
 */
@Injectable()
export class MeService {
  constructor(
    private readonly db: DbService,
    private readonly auth: AuthFlowProvider,
    private readonly licensing: LicensingService,
  ) {}

  async profile(ctx: RequestContext) {
    return this.db.withTenant(ctx, async (db) => {
      const u = await db.query(
        `SELECT id, email::text AS email, display_name AS "displayName", role, locale,
                (totp_secret_enc IS NOT NULL) AS "totpConfigured"
           FROM app.users WHERE id = $1`, [ctx.userId]);
      if (!u.rows[0]) throw new NotFoundException('Benutzer nicht gefunden');
      // Inhaber: alle aktiven Filialen; sonst nur zugewiesene (RLS + Kontext aus dem Guard)
      const stores = await db.query(
        `SELECT id, code, name FROM app.stores
          WHERE is_active AND ($1::text = 'owner' OR id = ANY($2::uuid[]))
          ORDER BY code`, [ctx.role, ctx.storeIds]);
      return {
        user: u.rows[0],
        permissions: permissionsFor(ctx.role),
        stores: stores.rows,
        license: this.licensing.gate.status(),
      };
    });
  }

  async setupTotp(ctx: RequestContext): Promise<{ secret: string; otpauthUri: string; expiresIn: number }> {
    this.assertTotpRole(ctx);
    const secret = generateTotpSecret();
    const encrypted = encryptTotpSecret(secret, this.auth.totpKey);
    return this.db.withTenant(ctx, async (db) => {
      const r = await db.query<{ email: string }>(
        `UPDATE app.users SET totp_pending_enc = $2, totp_pending_at = now()
          WHERE id = $1 RETURNING email::text AS email`,
        [ctx.userId, encrypted],
      );
      if (!r.rows[0]) throw new NotFoundException('Benutzer nicht gefunden');
      await this.audit(ctx, db, 'user.2fa.setup');
      return { secret, otpauthUri: totpUri(secret, r.rows[0].email), expiresIn: PENDING_TTL_SECONDS };
    });
  }

  async confirmTotp(ctx: RequestContext, code: string, nowSeconds = Math.floor(Date.now() / 1000)) {
    this.assertTotpRole(ctx);
    return this.db.withTenant(ctx, async (db) => {
      const r = await db.query<{ pending: Buffer | null; pendingAt: Date | null }>(
        `SELECT totp_pending_enc AS pending, totp_pending_at AS "pendingAt"
           FROM app.users WHERE id = $1 FOR UPDATE`,
        [ctx.userId],
      );
      const row = r.rows[0];
      if (!row) throw new NotFoundException('Benutzer nicht gefunden');
      if (!row.pending || !row.pendingAt) {
        throw new ConflictException('Keine 2FA-Einrichtung ausstehend – zuerst einrichten');
      }
      if (nowSeconds - Math.floor(row.pendingAt.getTime() / 1000) > PENDING_TTL_SECONDS) {
        throw new ConflictException('2FA-Einrichtung abgelaufen – bitte neu starten');
      }
      const step = matchingTotpStep(decryptTotpSecret(Buffer.from(row.pending), this.auth.totpKey), code, nowSeconds);
      if (step === null) throw new BadRequestException('Code ungültig');

      // Bestätigungscode gilt als verbraucht: derselbe Code kann danach nicht zum Login dienen
      await db.query(
        `UPDATE app.users
            SET totp_secret_enc = totp_pending_enc, totp_pending_enc = NULL, totp_pending_at = NULL,
                totp_last_used_step = $2
          WHERE id = $1`,
        [ctx.userId, step],
      );
      await this.audit(ctx, db, 'user.2fa.enable');
      return { totpConfigured: true };
    });
  }

  private assertTotpRole(ctx: RequestContext) {
    if (!TOTP_ROLES.has(ctx.role)) {
      throw new ForbiddenException('2FA ist für Inhaber und Filialleiter vorgesehen');
    }
  }

  private async audit(ctx: RequestContext, db: { query: (sql: string, params: unknown[]) => Promise<unknown> }, action: string) {
    await db.query(
      `INSERT INTO app.audit_log (tenant_id, user_id, device_id, action, entity_type, entity_id)
       VALUES ($1, $2, $3, $4, 'user', $2)`,
      [ctx.tenantId, ctx.userId, ctx.deviceId ?? null, action],
    );
  }
}
