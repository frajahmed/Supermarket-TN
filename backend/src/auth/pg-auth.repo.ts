import { Injectable } from '@nestjs/common';
import type { DeviceCertificate } from '../../../shared/license-core.ts';
import type { AuthRepo, Role } from '../core/auth-flow.ts';
import { DbService } from '../db/db.service';

/** AuthRepo über die SECURITY-DEFINER-Funktionen aus db/004_auth_devices.sql. */
@Injectable()
export class PgAuthRepo implements AuthRepo {
  constructor(private readonly db: DbService) {}

  loginCandidate(email: string) {
    return this.db.system(async (c) => {
      const r = await c.query('SELECT * FROM auth.login_candidate_with_totp($1)', [email]);
      const u = r.rows[0];
      if (!u) return null;
      return {
        userId: u.user_id as string, tenantId: u.tenant_id as string, role: u.role as Role,
        passwordHash: u.password_hash as string | null, pinHash: u.pin_hash as string | null,
        totpSecretEnc: u.totp_secret_enc ? Buffer.from(u.totp_secret_enc) : null,
        isActive: u.is_active as boolean,
        lockedUntil: u.locked_until ? Math.floor(new Date(u.locked_until).getTime() / 1000) : null,
      };
    });
  }

  async recordLoginAttempt(userId: string, success: boolean, deviceId: string) {
    await this.db.system((c) => c.query('SELECT auth.record_login_attempt($1, $2, $3)', [userId, success, deviceId]));
  }

  registerDevice(tenantId: string, cert: DeviceCertificate, certificate: string) {
    return this.db.system(async (c) => {
      const r = await c.query<{ ok: boolean }>(
        'SELECT auth.register_device($1, $2, $3, $4, $5, $6, NULL) AS ok',
        [tenantId, cert.did, cert.name, cert.kind, cert.dpk, certificate]);
      return r.rows[0].ok;
    });
  }

  async issueRefreshToken(t: { tenantId: string; userId: string; deviceId: string; familyId: string; tokenHash: Buffer; ttlSeconds: number }) {
    await this.db.system((c) => c.query('SELECT auth.issue_refresh_token($1, $2, $3, $4, $5, $6)',
      [t.tenantId, t.userId, t.deviceId, t.familyId, t.tokenHash, t.ttlSeconds]));
  }

  rotateRefreshToken(oldHash: Buffer, newHash: Buffer, ttlSeconds: number) {
    return this.db.system(async (c) => {
      const r = (await c.query('SELECT * FROM auth.rotate_refresh_token($1, $2, $3)', [oldHash, newHash, ttlSeconds])).rows[0];
      if (r.status === 'ok') {
        return { status: 'ok' as const, userId: r.user_id, tenantId: r.tenant_id, role: r.role as Role, deviceId: r.device_id };
      }
      return { status: r.status as 'reuse' | 'invalid' };
    });
  }

  async revokeRefreshFamily(tokenHash: Buffer) {
    await this.db.system((c) => c.query('SELECT auth.revoke_refresh_family($1)', [tokenHash]));
  }

  consumeTotpStep(userId: string, step: number) {
    return this.db.system(async (c) => {
      const r = await c.query<{ consume_totp_step: boolean }>(
        'SELECT auth.consume_totp_step($1, $2) AS consume_totp_step', [userId, step]);
      return r.rows[0]?.consume_totp_step === true;
    });
  }
}
