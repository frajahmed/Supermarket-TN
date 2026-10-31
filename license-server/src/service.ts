/**
 * Geschäftslogik des Lizenzservers: Lizenznehmer, Geräte-Freischaltung,
 * tägliche Lizenzbestätigung, Admin-Anmeldung.
 */
import { createHash, randomInt, randomUUID, type KeyObject } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import {
  DEVICE_KINDS, ISSUER, hashSecret, publicKeyFromB64, randomSecret, signToken, verifySecret, DUMMY_HASH,
  type DeviceCertificate, type DeviceKind, type LicenseMode, type LicenseToken,
} from '../../shared/license-core.ts';

const DAY = 86_400;
export const GRACE_DAYS = 14;          // so lange läuft ein Kundenserver ohne Internet weiter
export const PAYMENT_WARNING_DAYS = 7; // nach Ablauf der Miete: Warnung, danach Nur-Lesen
const SESSION_SECONDS = 8 * 3600;

export class ServiceError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const isDate = (s: unknown): s is string => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** Gut lesbarer Code ohne verwechselbare Zeichen (0/O, 1/I). */
function activationCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 8; i++) code += alphabet[randomInt(alphabet.length)];
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

interface LicenseeRow {
  id: string; name: string; tax_id: string | null; contact: string | null; plan: string;
  max_devices: number; paid_until: string; status: 'active' | 'suspended';
  install_secret_hash: string; last_check_at: number | null;
}
interface DeviceRow {
  id: string; licensee_id: string; name: string; kind: DeviceKind; public_key: string;
  activation_code: string; status: 'pending' | 'approved' | 'rejected' | 'revoked';
  certificate: string | null; requested_at: number; decided_at: number | null;
}

export class LicenseService {
  private readonly db: DatabaseSync;
  private readonly signingKey: KeyObject;
  private readonly clock: () => number;

  constructor(db: DatabaseSync, signingKey: KeyObject, clock: () => number = () => Math.floor(Date.now() / 1000)) {
    this.db = db;
    this.signingKey = signingKey;
    this.clock = clock;
  }

  private audit(actor: string, action: string, detail?: unknown) {
    this.db.prepare('INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)')
      .run(this.clock(), actor, action, detail === undefined ? null : JSON.stringify(detail));
  }

  private licensee(id: string): LicenseeRow {
    const row = this.db.prepare('SELECT * FROM licensees WHERE id = ?').get(id) as LicenseeRow | undefined;
    if (!row) throw new ServiceError(404, 'Lizenznehmer unbekannt');
    return row;
  }

  // -------------------------------------------------------------------------
  // Admins (du als Vermieter)
  // -------------------------------------------------------------------------
  async createAdmin(email: string, password: string): Promise<string> {
    if (password.length < 12) throw new ServiceError(400, 'Admin-Passwort muss mindestens 12 Zeichen haben');
    const id = randomUUID();
    this.db.prepare('INSERT INTO admins (id, email, password_hash) VALUES (?, ?, ?)')
      .run(id, email, await hashSecret(password));
    this.audit('system', 'admin.create', { email });
    return id;
  }

  async adminLogin(email: string, password: string): Promise<{ token: string; expiresAt: number }> {
    const admin = this.db.prepare('SELECT id, password_hash FROM admins WHERE email = ?').get(email) as
      { id: string; password_hash: string } | undefined;
    const ok = await verifySecret(password, admin?.password_hash ?? DUMMY_HASH);
    if (!admin || !ok) {
      this.audit('anonymous', 'admin.login_failed', { email });
      throw new ServiceError(401, 'Anmeldung fehlgeschlagen');
    }
    const token = randomSecret();
    const expiresAt = this.clock() + SESSION_SECONDS;
    this.db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(this.clock());
    this.db.prepare('INSERT INTO admin_sessions (token_hash, admin_id, expires_at) VALUES (?, ?, ?)')
      .run(sha256(token), admin.id, expiresAt);
    this.audit(`admin:${admin.id}`, 'admin.login');
    return { token, expiresAt };
  }

  /** Liefert die Admin-ID zu einem Sitzungstoken oder wirft 401. */
  adminFromSession(token: string | undefined): string {
    if (!token) throw new ServiceError(401, 'Nicht angemeldet');
    const row = this.db.prepare('SELECT admin_id, expires_at FROM admin_sessions WHERE token_hash = ?')
      .get(sha256(token)) as { admin_id: string; expires_at: number } | undefined;
    if (!row || row.expires_at < this.clock()) throw new ServiceError(401, 'Sitzung abgelaufen');
    return row.admin_id;
  }

  adminLogout(token: string) {
    this.db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(sha256(token));
  }

  // -------------------------------------------------------------------------
  // Lizenznehmer
  // -------------------------------------------------------------------------
  /** Legt einen Kunden an. Das Installations-Secret wird nur hier einmal im Klartext zurückgegeben. */
  createLicensee(adminId: string, input: { name: string; taxId?: string; contact?: string; plan?: string;
    maxDevices: number; paidUntil: string }): { installationId: string; installationSecret: string } {
    if (!input.name?.trim()) throw new ServiceError(400, 'Name fehlt');
    if (!Number.isInteger(input.maxDevices) || input.maxDevices < 1 || input.maxDevices > 500) {
      throw new ServiceError(400, 'maxDevices muss zwischen 1 und 500 liegen');
    }
    if (!isDate(input.paidUntil)) throw new ServiceError(400, 'paidUntil muss YYYY-MM-DD sein');
    const installationId = randomUUID();
    const installationSecret = randomSecret();
    this.db.prepare(`INSERT INTO licensees (id, name, tax_id, contact, plan, max_devices, paid_until, install_secret_hash)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(installationId, input.name.trim(), input.taxId ?? null, input.contact ?? null, input.plan ?? 'standard',
        input.maxDevices, input.paidUntil, sha256(installationSecret));
    this.audit(`admin:${adminId}`, 'licensee.create', { installationId, name: input.name });
    return { installationId, installationSecret };
  }

  updateLicensee(adminId: string, id: string, patch: { paidUntil?: string; maxDevices?: number;
    status?: 'active' | 'suspended'; plan?: string }) {
    const current = this.licensee(id);
    if (patch.paidUntil !== undefined && !isDate(patch.paidUntil)) throw new ServiceError(400, 'paidUntil ungültig');
    if (patch.maxDevices !== undefined && (!Number.isInteger(patch.maxDevices) || patch.maxDevices < 1)) {
      throw new ServiceError(400, 'maxDevices ungültig');
    }
    if (patch.status !== undefined && !['active', 'suspended'].includes(patch.status)) {
      throw new ServiceError(400, 'status ungültig');
    }
    this.db.prepare('UPDATE licensees SET paid_until = ?, max_devices = ?, status = ?, plan = ? WHERE id = ?')
      .run(patch.paidUntil ?? current.paid_until, patch.maxDevices ?? current.max_devices,
        patch.status ?? current.status, patch.plan ?? current.plan, id);
    this.audit(`admin:${adminId}`, 'licensee.update', { id, patch });
  }

  listLicensees() {
    return this.db.prepare(`
      SELECT l.id, l.name, l.tax_id AS taxId, l.plan, l.max_devices AS maxDevices, l.paid_until AS paidUntil,
             l.status, l.last_check_at AS lastCheckAt,
             (SELECT count(*) FROM devices d WHERE d.licensee_id = l.id AND d.status = 'approved') AS approvedDevices,
             (SELECT count(*) FROM devices d WHERE d.licensee_id = l.id AND d.status = 'pending')  AS pendingDevices
        FROM licensees l ORDER BY l.name`).all();
  }

  listDevices(licenseeId?: string, status?: string) {
    return this.db.prepare(`
      SELECT d.id, d.licensee_id AS licenseeId, l.name AS licenseeName, d.name, d.kind,
             d.activation_code AS activationCode, d.status, d.requested_at AS requestedAt,
             d.requested_ip AS requestedIp, d.decided_at AS decidedAt
        FROM devices d JOIN licensees l ON l.id = d.licensee_id
       WHERE (?1 IS NULL OR d.licensee_id = ?1) AND (?2 IS NULL OR d.status = ?2)
       ORDER BY d.requested_at DESC`).all(licenseeId ?? null, status ?? null);
  }

  // -------------------------------------------------------------------------
  // Geräte-Freischaltung
  // -------------------------------------------------------------------------
  /** Vom neuen Gerät aufgerufen (noch ohne jede Berechtigung). */
  requestActivation(input: { installationId: string; name: string; kind: string; publicKey: string }, ip?: string) {
    const lic = this.licensee(input.installationId);
    if (lic.status !== 'active') throw new ServiceError(403, 'Lizenz gesperrt – bitte Anbieter kontaktieren');
    if (!input.name?.trim() || input.name.length > 80) throw new ServiceError(400, 'Gerätename fehlt oder zu lang');
    if (!DEVICE_KINDS.includes(input.kind as DeviceKind)) throw new ServiceError(400, 'Gerätetyp ungültig');
    try {
      publicKeyFromB64(input.publicKey);
    } catch {
      throw new ServiceError(400, 'Öffentlicher Schlüssel ungültig');
    }

    // Erneute Anfrage desselben Geräts (z. B. App neu gestartet) -> bestehende Anfrage zurückgeben
    const existing = this.db.prepare('SELECT * FROM devices WHERE public_key = ?').get(input.publicKey) as DeviceRow | undefined;
    if (existing) {
      if (existing.licensee_id !== lic.id) throw new ServiceError(409, 'Schlüssel gehört zu einer anderen Installation');
      return { requestId: existing.id, activationCode: existing.activation_code, status: existing.status };
    }

    const pending = this.db.prepare(`SELECT count(*) AS n FROM devices WHERE licensee_id = ? AND status = 'pending'`)
      .get(lic.id) as { n: number };
    if (pending.n >= 20) throw new ServiceError(429, 'Zu viele offene Anfragen für diesen Kunden');

    const id = randomUUID();
    const code = activationCode();
    this.db.prepare(`INSERT INTO devices (id, licensee_id, name, kind, public_key, activation_code, requested_at, requested_ip)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, lic.id, input.name.trim(), input.kind, input.publicKey, code, this.clock(), ip ?? null);
    this.audit(`device:${id}`, 'device.request', { installationId: lic.id, name: input.name, kind: input.kind });
    return { requestId: id, activationCode: code, status: 'pending' as const };
  }

  /** Das Gerät fragt regelmäßig nach; nach Freigabe erhält es sein Zertifikat. */
  activationStatus(requestId: string) {
    const d = this.db.prepare('SELECT status, certificate FROM devices WHERE id = ?').get(requestId) as
      Pick<DeviceRow, 'status' | 'certificate'> | undefined;
    if (!d) throw new ServiceError(404, 'Anfrage unbekannt');
    return d.status === 'approved' ? { status: d.status, certificate: d.certificate } : { status: d.status };
  }

  approveDevice(adminId: string, deviceId: string): string {
    const d = this.db.prepare('SELECT * FROM devices WHERE id = ?').get(deviceId) as DeviceRow | undefined;
    if (!d) throw new ServiceError(404, 'Gerät unbekannt');
    if (d.status !== 'pending') throw new ServiceError(409, `Gerät ist bereits ${d.status}`);
    const lic = this.licensee(d.licensee_id);
    const approved = this.db.prepare(`SELECT count(*) AS n FROM devices WHERE licensee_id = ? AND status = 'approved'`)
      .get(lic.id) as { n: number };
    if (approved.n >= lic.max_devices) {
      throw new ServiceError(409, `Gerätelimit erreicht (${lic.max_devices}) – Vertrag erweitern oder ein Gerät sperren`);
    }
    const cert: DeviceCertificate = {
      typ: 'device', iss: ISSUER, inst: lic.id, did: d.id, dpk: d.public_key,
      kind: d.kind, name: d.name, iat: this.clock(),
    };
    const token = signToken(cert, this.signingKey);
    this.db.prepare(`UPDATE devices SET status = 'approved', certificate = ?, decided_at = ?, decided_by = ? WHERE id = ?`)
      .run(token, this.clock(), adminId, d.id);
    this.audit(`admin:${adminId}`, 'device.approve', { deviceId: d.id, licensee: lic.id });
    return token;
  }

  rejectDevice(adminId: string, deviceId: string) {
    const r = this.db.prepare(`UPDATE devices SET status = 'rejected', decided_at = ?, decided_by = ?
                               WHERE id = ? AND status = 'pending'`).run(this.clock(), adminId, deviceId);
    if (r.changes === 0) throw new ServiceError(409, 'Nur offene Anfragen können abgelehnt werden');
    this.audit(`admin:${adminId}`, 'device.reject', { deviceId });
  }

  /** Sperrt ein freigeschaltetes Gerät; wirkt beim nächsten Lizenzabgleich des Kundenservers. */
  revokeDevice(adminId: string, deviceId: string) {
    const r = this.db.prepare(`UPDATE devices SET status = 'revoked', decided_at = ?, decided_by = ?
                               WHERE id = ? AND status = 'approved'`).run(this.clock(), adminId, deviceId);
    if (r.changes === 0) throw new ServiceError(409, 'Nur freigeschaltete Geräte können gesperrt werden');
    this.audit(`admin:${adminId}`, 'device.revoke', { deviceId });
  }

  // -------------------------------------------------------------------------
  // Lizenzabgleich (Kundenserver -> Lizenzserver, stündlich)
  // -------------------------------------------------------------------------
  static modeFor(paidUntil: string, status: string, nowSec: number): LicenseMode {
    if (status !== 'active') return 'read_only';
    const today = new Date(nowSec * 1000).toISOString().slice(0, 10);
    if (paidUntil >= today) return 'active';
    const warnUntil = new Date(Date.parse(paidUntil) + PAYMENT_WARNING_DAYS * DAY * 1000).toISOString().slice(0, 10);
    return today <= warnUntil ? 'warning' : 'read_only';
  }

  checkLicense(installationId: string, installationSecret: string): string {
    const lic = this.db.prepare('SELECT * FROM licensees WHERE id = ?').get(installationId) as LicenseeRow | undefined;
    // gleicher Fehler für "unbekannt" und "falsches Secret"
    if (!lic || sha256(installationSecret) !== lic.install_secret_hash) {
      throw new ServiceError(401, 'Installation nicht autorisiert');
    }
    const now = this.clock();
    const revoked = (this.db.prepare(`SELECT id FROM devices WHERE licensee_id = ? AND status = 'revoked'`)
      .all(lic.id) as { id: string }[]).map((r) => r.id);
    const token: LicenseToken = {
      typ: 'license', iss: ISSUER, inst: lic.id, customer: lic.name, plan: lic.plan,
      maxDevices: lic.max_devices, paidUntil: lic.paid_until,
      mode: LicenseService.modeFor(lic.paid_until, lic.status, now),
      revokedDevices: revoked, iat: now, graceUntil: now + GRACE_DAYS * DAY,
    };
    this.db.prepare('UPDATE licensees SET last_check_at = ? WHERE id = ?').run(now, lic.id);
    return signToken(token, this.signingKey);
  }
}
