/**
 * Minimales JWT mit EdDSA (Ed25519) über node:crypto – ersetzt die Bibliothek `jose`.
 * Der Kundenserver erzeugt sein eigenes Schlüsselpaar bei der Installation.
 */
import { sign, verify, type KeyObject } from 'node:crypto';
import { b64url, fromB64url } from '../../../shared/license-core.ts';

export interface AccessClaims {
  sub: string;           // Benutzer-ID
  tid: string;           // Mandant
  role: 'owner' | 'manager' | 'stock_clerk' | 'cashier';
  did: string;           // freigeschaltetes Gerät
  iat: number;
  exp: number;
  iss: string;
}

export class JwtError extends Error {}

const HEADER = b64url(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' }));
export const JWT_ISSUER = 'supermarket-tn-store';

export function signJwt(claims: Omit<AccessClaims, 'iat' | 'exp' | 'iss'>, key: KeyObject, ttlSeconds: number,
  now = Math.floor(Date.now() / 1000)): string {
  const payload = b64url(JSON.stringify({ ...claims, iat: now, exp: now + ttlSeconds, iss: JWT_ISSUER }));
  const input = `${HEADER}.${payload}`;
  return `${input}.${b64url(sign(null, Buffer.from(input), key))}`;
}

export function verifyJwt(token: string, key: KeyObject, now = Math.floor(Date.now() / 1000)): AccessClaims {
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtError('Format ungültig');
  const [h, p, s] = parts;
  if (h !== HEADER) throw new JwtError('Algorithmus nicht erlaubt');       // schließt alg=none u. a. aus
  if (!verify(null, Buffer.from(`${h}.${p}`), key, fromB64url(s))) throw new JwtError('Signatur ungültig');
  let c: AccessClaims;
  try {
    c = JSON.parse(fromB64url(p).toString('utf8'));
  } catch {
    throw new JwtError('Payload ungültig');
  }
  if (c.iss !== JWT_ISSUER) throw new JwtError('Aussteller ungültig');
  if (typeof c.exp !== 'number' || c.exp <= now) throw new JwtError('Abgelaufen');
  if (!c.sub || !c.tid || !c.did || !['owner', 'manager', 'stock_clerk', 'cashier'].includes(c.role)) {
    throw new JwtError('Claims unvollständig');
  }
  return c;
}
