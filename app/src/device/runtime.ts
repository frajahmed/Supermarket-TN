import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import { decodeBase64Url } from '../core/base64url';
import { createChallengeProof, publicKeyToSpkiBase64 } from '../core/challenge';
import { encodeBase64Url } from '../core/base64url';
import {
  AUTH_SESSION_KEY, DEVICE_CERTIFICATE_KEY, DeviceIdentity, loadOrCreateIdentity,
  SERVER_URL_KEY, SecureStoreLike,
} from '../core/identity';

const secureStore: SecureStoreLike = SecureStore;

export async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  return loadOrCreateIdentity(secureStore, async () => {
    const keyPair = nacl.sign.keyPair();
    return {
      publicKey: publicKeyToSpkiBase64(keyPair.publicKey),
      privateKey: encodeBase64Url(keyPair.secretKey),
    };
  });
}

export async function deviceProof(identity: DeviceIdentity, challenge: string) {
  const secret = nacl.sign.keyPair.fromSecretKey(decodeBase64Url(identity.privateKey)).secretKey;
  const proof = await createChallengeProof(challenge, async (message) => nacl.sign.detached(message, secret));
  return { certificate: (await secureStore.getItemAsync(DEVICE_CERTIFICATE_KEY)) ?? '', ...proof };
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
