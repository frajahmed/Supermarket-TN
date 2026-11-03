import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { DEFAULT_LANGUAGE, type AppLanguage } from '../core/language.ts';
import { resources } from './translations';

void i18n.use(initReactI18next).init({
  resources, lng: DEFAULT_LANGUAGE, fallbackLng: 'fr', interpolation: { escapeValue: false },
});

export async function applyLanguage(language: AppLanguage): Promise<void> {
  await i18n.changeLanguage(language);
}

export { i18n };
