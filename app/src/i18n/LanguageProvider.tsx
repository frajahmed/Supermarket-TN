import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { View } from 'react-native';
import {
  DEFAULT_LANGUAGE, directionForLanguage, loadLanguage, saveLanguage, type AppLanguage, type LayoutDirection,
} from '../core/language.ts';
import { secureStore } from '../device/runtime';
import { applyLanguage } from './index';

interface LanguageContextValue {
  language: AppLanguage;
  direction: LayoutDirection;
  setLanguage: (language: AppLanguage) => Promise<void>;
}

const LanguageContext = createContext<LanguageContextValue>({
  language: DEFAULT_LANGUAGE, direction: 'ltr', setLanguage: async () => undefined,
});

/**
 * Schreibrichtung über den Layout-Stil `direction` statt I18nManager.forceRTL:
 * Wirkt sofort ohne Neustart, Eingaben in offenen Formularen bleiben erhalten.
 * Die gewählte Sprache wird gespeichert und vor dem ersten Rendern angewendet.
 */
export function LanguageProvider({ children }: { children: ReactNode }) {
  const [language, setLanguageState] = useState<AppLanguage | null>(null);

  useEffect(() => {
    void loadLanguage(secureStore).then(async (stored) => {
      await applyLanguage(stored);
      setLanguageState(stored);
    }).catch(() => setLanguageState(DEFAULT_LANGUAGE));
  }, []);

  const setLanguage = useCallback(async (next: AppLanguage) => {
    await applyLanguage(next);
    setLanguageState(next);
    await saveLanguage(secureStore, next).catch(() => undefined);
  }, []);

  const value = useMemo<LanguageContextValue>(() => ({
    language: language ?? DEFAULT_LANGUAGE,
    direction: directionForLanguage(language ?? DEFAULT_LANGUAGE),
    setLanguage,
  }), [language, setLanguage]);

  if (language === null) return null;   // erst rendern, wenn die gespeicherte Sprache feststeht
  return (
    <LanguageContext.Provider value={value}>
      <View style={{ flex: 1, direction: value.direction }}>{children}</View>
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageContextValue {
  return useContext(LanguageContext);
}
