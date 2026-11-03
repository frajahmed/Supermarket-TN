import { decodeBase64Url, encodeBase64Url } from './base64url.ts';
import { publicKeyToSpkiBase64 } from './challenge.ts';

export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** Geräteidentität: öffentlicher Schlüssel (SPKI, Base64) + 32-Byte-Seed des privaten Schlüssels (Base64url). */
export interface DeviceIdentity {
  publicKey: string;
  privateKey: string;
}

/** Ed25519-Schlüsselpaar aus einem 32-Byte-Seed (in der App: tweetnacl `nacl.sign.keyPair.fromSeed`). */
export type KeyPairFromSeed = (seed: Uint8Array) => { publicKey: Uint8Array; secretKey: Uint8Array };
/** Kryptografisch sichere Zufallsbytes (in der App: expo-crypto `getRandomBytes`). */
export type RandomBytes = (count: number) => Uint8Array;

export const DEVICE_IDENTITY_KEY = 'stn.device.identity.v1';
export const DEVICE_CERTIFICATE_KEY = 'stn.device.certificate.v1';
export const SELECTED_STORE_KEY = 'stn.selected-store.v1';
export const AUTH_SESSION_KEY = 'stn.auth.session.v1';
export const SERVER_URL_KEY = 'stn.server.url.v1';

/**
 * Erzeugt eine neue Identität. Die Zufallsbytes kommen ausdrücklich von außen (expo-crypto):
 * React Native hat keine eingebaute Zufallsquelle, der eigene Generator von tweetnacl wirft dort "no PRNG".
 */
export function generateIdentity(randomBytes: RandomBytes, fromSeed: KeyPairFromSeed): DeviceIdentity {
  const seed = randomBytes(32);
  if (!(seed instanceof Uint8Array) || seed.length !== 32) throw new Error('Zufallsquelle lieferte keinen 32-Byte-Seed');
  if (seed.every((b) => b === 0)) throw new Error('Zufallsquelle lieferte nur Nullen');
  const pair = fromSeed(seed);
  return { publicKey: publicKeyToSpkiBase64(pair.publicKey), privateKey: encodeBase64Url(seed) };
}

/** Geheimer Signaturschlüssel (64 Byte, tweetnacl-Format) aus der gespeicherten Identität. */
export function signingKey(identity: DeviceIdentity, fromSeed: KeyPairFromSeed): Uint8Array {
  let seed = decodeBase64Url(identity.privateKey);
  if (seed.length === 64) seed = seed.slice(0, 32);   // ältere Fassung speicherte den 64-Byte-secretKey (Seed || Public)
  if (seed.length !== 32) throw new Error('Gespeicherter Geräteschlüssel ist beschädigt');
  return fromSeed(seed).secretKey;
}

export async function loadOrCreateIdentity(
  secureStore: SecureStoreLike,
  generate: () => Promise<DeviceIdentity>,
): Promise<DeviceIdentity> {
  const stored = await secureStore.getItemAsync(DEVICE_IDENTITY_KEY);
  if (stored) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (typeof parsed === 'object' && parsed !== null
          && typeof (parsed as { publicKey?: unknown }).publicKey === 'string'
          && typeof (parsed as { privateKey?: unknown }).privateKey === 'string') {
        return parsed as DeviceIdentity;
      }
    } catch {
      await secureStore.deleteItemAsync(DEVICE_IDENTITY_KEY);
    }
  }
  const identity = await generate();
  await secureStore.setItemAsync(DEVICE_IDENTITY_KEY, JSON.stringify(identity));
  return identity;
}
