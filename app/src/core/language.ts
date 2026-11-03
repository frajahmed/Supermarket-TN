import type { SecureStoreLike } from './identity.ts';

export type AppLanguage = 'ar' | 'fr' | 'en';
export type LayoutDirection = 'rtl' | 'ltr';

export const LANGUAGE_KEY = 'stn.language.v1';
export const DEFAULT_LANGUAGE: AppLanguage = 'fr';
export const LANGUAGES: readonly AppLanguage[] = ['ar', 'fr', 'en'];

export function isAppLanguage(value: unknown): value is AppLanguage {
  return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

export function directionForLanguage(language: AppLanguage): LayoutDirection {
  return language === 'ar' ? 'rtl' : 'ltr';
}

/** Gespeicherte Sprache – beim Start vor dem ersten Rendern angewendet. */
export async function loadLanguage(store: SecureStoreLike): Promise<AppLanguage> {
  const value = await store.getItemAsync(LANGUAGE_KEY);
  return isAppLanguage(value) ? value : DEFAULT_LANGUAGE;
}

export async function saveLanguage(store: SecureStoreLike, language: AppLanguage): Promise<void> {
  await store.setItemAsync(LANGUAGE_KEY, language);
}
