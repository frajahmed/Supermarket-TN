import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, type KeyObject } from 'node:crypto';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

function base32Bytes(secret: string): Buffer {
  const normalized = secret.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z2-7]+={0,6}$/.test(normalized)) throw new Error('TOTP-Geheimnis ist ungültig');
  const body = normalized.replace(/=+$/, '');
  let bits = '';
  for (const char of body) bits += ("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(char)).toString(2).padStart(5, '0');
  const bytes = Buffer.alloc(Math.floor(bits.length / 8));
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  if (bytes.length < 10) throw new Error('TOTP-Geheimnis ist zu kurz');
  return bytes;
}

/** RFC-6238-TOTP mit SHA-1 und sechs Stellen für die Kassenanmeldung. */
export function generateTotpCode(secret: string, timestampSeconds: number): string {
  const counter = Math.floor(timestampSeconds / TOTP_STEP_SECONDS);
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error('TOTP-Zeit ist ungültig');
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac('sha1', base32Bytes(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(TOTP_DIGITS, '0');
}

/** Liefert den Zeit-Schritt des passenden Codes; ±1 Schritt wird akzeptiert. */
export function matchingTotpStep(secret: string, code: string, timestampSeconds: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = Math.floor(timestampSeconds / TOTP_STEP_SECONDS);
  for (const step of [current, current - 1, current + 1]) {
    if (step >= 0 && generateTotpCode(secret, step * TOTP_STEP_SECONDS) === code) return step;
  }
  return null;
}

export function deriveTotpKey(jwtPrivateKey: KeyObject): Buffer {
  const material = jwtPrivateKey.export({ type: 'pkcs8', format: 'der' });
  return createHash('sha256').update(material).update('supermarket-tn-totp-v1').digest();
}

export function encryptTotpSecret(secret: string, key: Buffer): Buffer {
  if (key.length !== 32) throw new Error('TOTP-Verschlüsselungsschlüssel ist ungültig');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret.replace(/[\s-]/g, '').toUpperCase(), 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptTotpSecret(value: Buffer, key: Buffer): string {
  if (key.length !== 32 || value.length < 29 || value[0] !== 1) throw new Error('TOTP-Geheimnis ist nicht lesbar');
  const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(1, 13));
  decipher.setAuthTag(value.subarray(13, 29));
  return Buffer.concat([decipher.update(value.subarray(29)), decipher.final()]).toString('utf8');
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC-4648-Base32 ohne Auffüllzeichen (Format, das Authenticator-Apps erwarten). */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Neues TOTP-Geheimnis mit 160 Bit (RFC 4226 empfiehlt mindestens 128, besser 160). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** otpauth-URI für den QR-Code der Authenticator-App. */
export function totpUri(secret: string, accountName: string, issuer = 'Supermarket-TN'): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}
