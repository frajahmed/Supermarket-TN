export type AppLanguage = 'ar' | 'fr' | 'en';
export type LayoutDirection = 'rtl' | 'ltr';

export function directionForLanguage(language: AppLanguage): LayoutDirection {
  return language === 'ar' ? 'rtl' : 'ltr';
}

export interface DraftState {
  language: AppLanguage;
  direction: LayoutDirection;
  email: string;
  serverUrl: string;
}

/** Sprachwechsel ist ein reiner Zustandswechsel: Formulardaten bleiben erhalten. */
export function changeLanguage(state: DraftState, language: AppLanguage): DraftState {
  return { ...state, language, direction: directionForLanguage(language) };
}
