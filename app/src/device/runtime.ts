import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import { createChallengeProof } from '../core/challenge.ts';
import {
  AUTH_SESSION_KEY, DEVICE_CERTIFICATE_KEY, generateIdentity, loadOrCreateIdentity,
  SERVER_URL_KEY, signingKey, type DeviceIdentity, type SecureStoreLike,
} from '../core/identity.ts';

/**
 * React Native/Hermes hat kein crypto.getRandomValues. tweetnacl würde ohne diese
 * Zuweisung bei jeder Nutzung seines Zufallsgenerators "no PRNG" werfen.
 * Schlüssel erzeugen wir zusätzlich ausdrücklich aus einem expo-crypto-Seed.
 */
nacl.setPRNG((target: Uint8Array, count: number) => {
  target.set(Crypto.getRandomBytes(count));
});

export const secureStore: SecureStoreLike = SecureStore;
const fromSeed = (seed: Uint8Array) => nacl.sign.keyPair.fromSeed(seed);

export async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  return loadOrCreateIdentity(secureStore, async () => generateIdentity((n) => Crypto.getRandomBytes(n), fromSeed));
}

export async function deviceProof(identity: DeviceIdentity, challenge: string) {
  const secret = signingKey(identity, fromSeed);
  const proof = await createChallengeProof(challenge, async (message) => nacl.sign.detached(message, secret));
  return { certificate: (await secureStore.getItemAsync(DEVICE_CERTIFICATE_KEY)) ?? '', ...proof };
}

export async function hasDeviceCertificate(): Promise<boolean> {
  return Boolean(await secureStore.getItemAsync(DEVICE_CERTIFICATE_KEY));
}

export async function saveDeviceCertificate(certificate: string): Promise<void> {
  await secureStore.setItemAsync(DEVICE_CERTIFICATE_KEY, certificate);
}

export async function saveAuthSession(session: unknown): Promise<void> {
  await secureStore.setItemAsync(AUTH_SESSION_KEY, JSON.stringify(session));
}

export async function loadAccessToken(): Promise<string | null> {
  const value = await secureStore.getItemAsync(AUTH_SESSION_KEY);
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null
      && typeof (parsed as { accessToken?: unknown }).accessToken === 'string'
      ? (parsed as { accessToken: string }).accessToken
      : null;
  } catch {
    return null;
  }
}

export async function saveServerUrl(serverUrl: string): Promise<void> {
  await secureStore.setItemAsync(SERVER_URL_KEY, serverUrl);
}

export async function loadServerUrl(): Promise<string | null> {
  return secureStore.getItemAsync(SERVER_URL_KEY);
}
