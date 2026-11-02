export interface SecureStoreLike {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface DeviceIdentity {
  publicKey: string;
  privateKey: string;
}

export const DEVICE_IDENTITY_KEY = 'stn.device.identity.v1';
export const DEVICE_CERTIFICATE_KEY = 'stn.device.certificate.v1';
export const AUTH_SESSION_KEY = 'stn.auth.session.v1';
export const SERVER_URL_KEY = 'stn.server.url.v1';

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
