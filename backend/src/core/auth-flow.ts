/**
 * Anmeldeablauf des Kundenservers – unabhängig von NestJS, damit er direkt testbar ist.
 *
 * Jede Anmeldung braucht ZWEI Dinge:
 *   1. ein freigeschaltetes Gerät: gültiges Zertifikat vom Lizenzserver + Signatur einer
 *      Einmal-Challenge mit dem privaten Geräteschlüssel (beweist, dass es wirklich dieses Gerät ist)
 *   2. einen Benutzer: E-Mail + Passwort (Inhaber/Filialleiter) oder Kassen-PIN (Kasse/Lager)
 *
 * Danach: kurzlebiges Access-Token (15 min) + rotierendes Refresh-Token (30 Tage).
 * Wird ein bereits benutztes Refresh-Token erneut vorgelegt (Diebstahl), wird die ganze Kette gesperrt.
 */
import { createHash, randomBytes, randomUUID, type KeyObject } from 'node:crypto';
import {
  DUMMY_HASH, TokenError, verifyChallenge, verifySecret, verifyToken, b64url,
  type DeviceCertificate,
} from '../../../shared/license-core.ts';
import { signJwt, type AccessClaims } from './jwt.ts';
import type { LicenseGate } from './license-gate.ts';
import { decryptTotpSecret, matchingTotpStep } from './totp.ts';

export type Role = AccessClaims['role'];

export class AuthError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/** Datenbankzugriff – implementiert über die SECURITY-DEFINER-Funktionen aus Migration 004. */
export interface AuthRepo {
  loginCandidate(email: string): Promise<{
    userId: string; tenantId: string; role: Role; passwordHash: string | null; pinHash: string | null;
    totpSecretEnc: Buffer | null; isActive: boolean; lockedUntil: number | null;
  } | null>;
  recordLoginAttempt(userId: string, success: boolean, deviceId: string): Promise<void>;
  /** Legt das Gerät beim ersten Login an; liefert false, wenn der Inhaber es lokal gesperrt hat. */
  registerDevice(tenantId: string, cert: DeviceCertificate, certificate: string): Promise<boolean>;
  issueRefreshToken(t: { tenantId: string; userId: string; deviceId: string; familyId: string; tokenHash: Buffer; ttlSeconds: number }): Promise<void>;
  rotateRefreshToken(oldHash: Buffer, newHash: Buffer, ttlSeconds: number): Promise<
    | { status: 'ok'; userId: string; tenantId: string; role: Role; deviceId: string }
    | { status: 'reuse' | 'invalid' }>;
  revokeRefreshFamily(tokenHash: Buffer): Promise<void>;
  consumeTotpStep(userId: string, step: number): Promise<boolean>;
}

/** Einmal-Challenges: 60 Sekunden gültig, nur einmal verwendbar. Lokaler Server = ein Prozess -> Speicher genügt. */
export class ChallengeStore {
  private readonly items = new Map<string, number>();
  private readonly ttl: number;
  private readonly clock: () => number;
  constructor(ttlSeconds = 60, clock: () => number = () => Math.floor(Date.now() / 1000)) {
    this.ttl = ttlSeconds;
    this.clock = clock;
  }
  issue(): string {
    const now = this.clock();
    for (const [k, exp] of this.items) if (exp < now) this.items.delete(k);
    if (this.items.size > 10_000) throw new AuthError(429, 'Zu viele offene Anmeldungen');
    const c = b64url(randomBytes(24));
    this.items.set(c, now + this.ttl);
    return c;
  }
  consume(c: string): boolean {
    const exp = this.items.get(c);
    this.items.delete(c);
    return exp !== undefined && exp >= this.clock();
  }
}

export interface LoginInput {
  email: string;
  password?: string;
  pin?: string;
  totp?: string;
  device: { certificate: string; challenge: string; signature: string };
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  user: { id: string; tenantId: string; role: Role };
  device: { id: string; name: string; kind: string };
  license: ReturnType<LicenseGate['status']>;
}

const ACCESS_TTL = 15 * 60;
const REFRESH_TTL = 30 * 86_400;
const PIN_ROLES: readonly Role[] = ['cashier', 'stock_clerk'];
const sha256 = (s: string) => createHash('sha256').update(s).digest();

export class AuthFlow {
  private readonly deps: {
    repo: AuthRepo; gate: LicenseGate; challenges: ChallengeStore;
    licensePublicKey: KeyObject; installationId: string; jwtKey: KeyObject; totpKey: Buffer; clock?: () => number;
  };
  constructor(deps: AuthFlow['deps']) {
    this.deps = deps;
  }

  private now() {
    return (this.deps.clock ?? (() => Math.floor(Date.now() / 1000)))();
  }

  /** Prüft Gerätezertifikat + Besitznachweis. */
  verifyDevice(d: LoginInput['device']): DeviceCertificate {
    let cert: DeviceCertificate;
    try {
      cert = verifyToken<DeviceCertificate>(d.certificate, this.deps.licensePublicKey, 'device');
    } catch (e) {
      throw new AuthError(401, e instanceof TokenError ? `Gerät nicht freigeschaltet (${e.message})` : 'Gerät nicht freigeschaltet');
    }
    if (cert.inst !== this.deps.installationId) throw new AuthError(401, 'Gerät gehört zu einem anderen Kunden');
    if (this.deps.gate.isDeviceRevoked(cert.did)) throw new AuthError(403, 'Gerät wurde gesperrt');
    if (!this.deps.challenges.consume(d.challenge)) throw new AuthError(401, 'Challenge abgelaufen oder bereits benutzt');
    if (!verifyChallenge(d.challenge, d.signature, cert.dpk)) throw new AuthError(401, 'Gerätesignatur ungültig');
    return cert;
  }

  async login(input: LoginInput): Promise<TokenPair> {
    const license = this.deps.gate.status();
    if (license.mode === 'unlicensed') throw new AuthError(403, license.reason);

    const cert = this.verifyDevice(input.device);
    const usePin = input.pin !== undefined && input.password === undefined;
    const secret = usePin ? input.pin! : input.password ?? '';

    const user = await this.deps.repo.loginCandidate(input.email.trim());
    const stored = user ? (usePin ? user.pinHash : user.passwordHash) : null;
    // Immer einen Hash prüfen – gleiche Antwortzeit für unbekannte und bekannte Benutzer
    const secretOk = await verifySecret(secret, stored ?? DUMMY_HASH) && stored !== null;

    if (!user || !user.isActive) throw new AuthError(401, 'Anmeldung fehlgeschlagen');
    if (user.lockedUntil && user.lockedUntil > this.now()) {
      throw new AuthError(423, 'Zu viele Fehlversuche – Konto vorübergehend gesperrt');
    }
    if (usePin && !PIN_ROLES.includes(user.role)) {
      throw new AuthError(401, 'PIN-Anmeldung nur für Kasse und Lager – bitte Passwort verwenden');
    }
    if (usePin && !['pos', 'scanner', 'tablet'].includes(cert.kind)) {
      throw new AuthError(401, 'PIN-Anmeldung nur an Kasse, Scanner oder Tablet');
    }
    if (!secretOk) {
      await this.deps.repo.recordLoginAttempt(user.userId, false, cert.did);
      throw new AuthError(401, 'Anmeldung fehlgeschlagen');
    }

    if (user.totpSecretEnc) {
      if (!input.totp) throw new AuthError(401, 'TOTP-Code erforderlich');
      let totpSecret: string;
      try {
        totpSecret = decryptTotpSecret(user.totpSecretEnc, this.deps.totpKey);
      } catch {
        throw new AuthError(500, 'Zwei-Faktor-Anmeldung ist nicht verfügbar');
      }
      const step = matchingTotpStep(totpSecret, input.totp, this.now());
      if (step === null || !(await this.deps.repo.consumeTotpStep(user.userId, step))) {
        throw new AuthError(401, 'TOTP-Code ungültig oder bereits verwendet');
      }
    }

    if (!(await this.deps.repo.registerDevice(user.tenantId, cert, input.device.certificate))) {
      throw new AuthError(403, 'Gerät wurde vom Inhaber gesperrt');
    }
    await this.deps.repo.recordLoginAttempt(user.userId, true, cert.did);

    const refreshToken = b64url(randomBytes(32));
    await this.deps.repo.issueRefreshToken({
      tenantId: user.tenantId, userId: user.userId, deviceId: cert.did, familyId: randomUUID(),
      tokenHash: sha256(refreshToken), ttlSeconds: REFRESH_TTL,
    });
    return {
      accessToken: signJwt({ sub: user.userId, tid: user.tenantId, role: user.role, did: cert.did }, this.deps.jwtKey, ACCESS_TTL, this.now()),
      refreshToken,
      expiresIn: ACCESS_TTL,
      user: { id: user.userId, tenantId: user.tenantId, role: user.role },
      device: { id: cert.did, name: cert.name, kind: cert.kind },
      license,
    };
  }

  async refresh(refreshToken: string): Promise<Omit<TokenPair, 'device' | 'user'> & { user: TokenPair['user'] }> {
    const license = this.deps.gate.status();
    if (license.mode === 'unlicensed') throw new AuthError(403, license.reason);
    const next = b64url(randomBytes(32));
    const r = await this.deps.repo.rotateRefreshToken(sha256(refreshToken), sha256(next), REFRESH_TTL);
    if (r.status === 'reuse') throw new AuthError(401, 'Sitzung wurde aus Sicherheitsgründen beendet – bitte neu anmelden');
    if (r.status !== 'ok') throw new AuthError(401, 'Sitzung abgelaufen');
    if (this.deps.gate.isDeviceRevoked(r.deviceId)) {
      await this.deps.repo.revokeRefreshFamily(sha256(next));
      throw new AuthError(403, 'Gerät wurde gesperrt');
    }
    return {
      accessToken: signJwt({ sub: r.userId, tid: r.tenantId, role: r.role, did: r.deviceId }, this.deps.jwtKey, ACCESS_TTL, this.now()),
      refreshToken: next,
      expiresIn: ACCESS_TTL,
      user: { id: r.userId, tenantId: r.tenantId, role: r.role },
      license,
    };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.deps.repo.revokeRefreshFamily(sha256(refreshToken));
  }
}
