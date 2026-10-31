/**
 * Gemeinsamer Kern für Lizenzserver und Kundenserver.
 * Nur Node-Bordmittel (node:crypto) – keine externen Pakete.
 *
 * Signiertes Token = base64url(JSON-Payload) + "." + base64url(Ed25519-Signatur)
 * Der Lizenzserver signiert mit seinem privaten Schlüssel; jeder Kundenserver
 * kennt nur den öffentlichen Schlüssel und kann Tokens prüfen, aber nie fälschen.
 */
import {
  createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes,
  scrypt, sign, timingSafeEqual, verify, type KeyObject,
} from 'node:crypto';

export const ISSUER = 'supermarket-tn-license';

export type DeviceKind = 'pos' | 'scanner' | 'tablet' | 'phone' | 'pc';
export const DEVICE_KINDS: readonly DeviceKind[] = ['pos', 'scanner', 'tablet', 'phone', 'pc'];

/** Zertifikat, das ein freigeschaltetes Gerät bei jeder Anmeldung vorzeigt. */
export interface DeviceCertificate {
  typ: 'device';
  iss: typeof ISSUER;
  inst: string;          // Installations-ID des Kunden (eine pro Kundenserver)
  did: string;           // Geräte-ID
  dpk: string;           // öffentlicher Schlüssel des Geräts (SPKI DER, base64)
  kind: DeviceKind;
  name: string;
  iat: number;           // Ausstellungszeit (Unix-Sekunden)
}

export type LicenseMode = 'active' | 'warning' | 'read_only';

/** Tägliche Lizenzbestätigung für einen Kundenserver. */
export interface LicenseToken {
  typ: 'license';
  iss: typeof ISSUER;
  inst: string;
  customer: string;
  plan: string;
  maxDevices: number;
  paidUntil: string;           // YYYY-MM-DD
  mode: LicenseMode;           // vom Lizenzserver berechnet
  revokedDevices: string[];    // gesperrte Geräte-IDs
  iat: number;
  graceUntil: number;          // bis dahin gilt die Bestätigung auch ohne Internet
}

export type SignedPayload = DeviceCertificate | LicenseToken;

// ---------------------------------------------------------------------------
// base64url
// ---------------------------------------------------------------------------
export const b64url = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');
export const fromB64url = (s: string): Buffer => Buffer.from(s, 'base64url');

// ---------------------------------------------------------------------------
// Schlüssel
// ---------------------------------------------------------------------------
export function generateSigningKeys(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

export const loadPrivateKey = (pem: string): KeyObject => createPrivateKey(pem);
export const loadPublicKey = (pem: string): KeyObject => createPublicKey(pem);

/** Öffentlicher Geräteschlüssel als base64 (SPKI DER) – so wird er übertragen und gespeichert. */
export function publicKeyToB64(key: KeyObject): string {
  return key.export({ type: 'spki', format: 'der' }).toString('base64');
}

export function publicKeyFromB64(b64: string): KeyObject {
  const key = createPublicKey({ key: Buffer.from(b64, 'base64'), format: 'der', type: 'spki' });
  if (key.asymmetricKeyType !== 'ed25519') throw new TokenError('Gerätschlüssel muss Ed25519 sein');
  return key;
}

// ---------------------------------------------------------------------------
// Signierte Tokens
// ---------------------------------------------------------------------------
export class TokenError extends Error {}

export function signToken(payload: SignedPayload, privateKey: KeyObject): string {
  const body = b64url(JSON.stringify(payload));
  const sig = sign(null, Buffer.from(body), privateKey);
  return `${body}.${b64url(sig)}`;
}

/** Prüft Signatur, Aussteller und Typ. Wirft TokenError bei jeder Abweichung. */
export function verifyToken<T extends SignedPayload>(token: string, publicKey: KeyObject, typ: T['typ']): T {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) throw new TokenError('Token-Format ungültig');
  const [body, sig] = parts;
  if (!verify(null, Buffer.from(body), publicKey, fromB64url(sig))) throw new TokenError('Signatur ungültig');
  let payload: SignedPayload;
  try {
    payload = JSON.parse(fromB64url(body).toString('utf8'));
  } catch {
    throw new TokenError('Payload ungültig');
  }
  if (payload.iss !== ISSUER) throw new TokenError('Falscher Aussteller');
  if (payload.typ !== typ) throw new TokenError(`Erwartet ${typ}, erhalten ${payload.typ}`);
  return payload as T;
}

// ---------------------------------------------------------------------------
// Besitznachweis: das Gerät signiert eine Einmal-Challenge des Servers
// ---------------------------------------------------------------------------
export function signChallenge(challenge: string, devicePrivateKey: KeyObject): string {
  return b64url(sign(null, Buffer.from(`stn-login:${challenge}`), devicePrivateKey));
}

export function verifyChallenge(challenge: string, signatureB64url: string, devicePublicKeyB64: string): boolean {
  try {
    return verify(null, Buffer.from(`stn-login:${challenge}`), publicKeyFromB64(devicePublicKeyB64),
      fromB64url(signatureB64url));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Passwörter / PINs: scrypt (in Node eingebaut, keine nativen Abhängigkeiten auf
// den Kundenservern). Format: scrypt$N$r$p$salt$hash (base64url)
// ---------------------------------------------------------------------------
const SCRYPT = { N: 1 << 16, r: 8, p: 1, keyLen: 32, maxmem: 160 * 1024 * 1024 };

function scryptAsync(secret: string, salt: Buffer, N: number, r: number, p: number, keyLen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(secret.normalize('NFKC'), salt, keyLen, { N, r, p, maxmem: SCRYPT.maxmem },
      (err, key) => (err ? reject(err) : resolve(key))));
}

export async function hashSecret(secret: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(secret, salt, SCRYPT.N, SCRYPT.r, SCRYPT.p, SCRYPT.keyLen);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, b64url(salt), b64url(key)].join('$');
}

export async function verifySecret(secret: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [algo, n, r, p, salt, hash] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const expected = fromB64url(hash);
  const actual = await scryptAsync(secret, fromB64url(salt), Number(n), Number(r), Number(p), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Dummy-Hash, damit unbekannte Benutzer gleich lange brauchen wie bekannte (kein Benutzer-Raten über Zeit). */
export const DUMMY_HASH = 'scrypt$65536$8$1$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

/** Zufälliges Geheimnis (z. B. Installations-Secret, Refresh-Token). */
export const randomSecret = (bytes = 32): string => b64url(randomBytes(bytes));
