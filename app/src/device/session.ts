import { router } from 'expo-router';
import type { ApiClient } from '../core/api-client';
import type { Profile } from '../core/home';
import { pickStore } from '../core/home';
import { createApiClient, loadSelectedStore, saveSelectedStore } from './runtime';

// Ein API-Client pro App-Prozess, damit alle Bildschirme dieselbe Token-Erneuerung teilen.
let api: ApiClient | null = null;
let profile: Profile | null = null;
let storeId: string | null = null;

/** Nach Anmelden/Abmelden: nichts vom vorherigen Benutzer weiterverwenden. */
export function resetSession() {
  api = null;
  profile = null;
  storeId = null;
}

export async function getApi(): Promise<ApiClient> {
  api ??= await createApiClient(() => { resetSession(); router.replace('/login'); });
  if (!api) { router.replace('/'); throw new Error('Gerät nicht eingerichtet'); }
  return api;
}

export async function loadProfile(force = false): Promise<Profile> {
  if (profile && !force) return profile;
  profile = await (await getApi()).get<Profile>('/api/v1/me');
  storeId = pickStore(profile.stores, storeId ?? await loadSelectedStore());
  if (storeId) await saveSelectedStore(storeId);
  return profile;
}

export function currentStoreId(): string | null {
  return storeId;
}

export async function selectStore(id: string): Promise<void> {
  storeId = id;
  await saveSelectedStore(id);
}

export async function signOut(): Promise<void> {
  const client = api;
  resetSession();
  await client?.signOut().catch(() => undefined);
}
