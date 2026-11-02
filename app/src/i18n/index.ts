import i18n from 'i18next';
import { I18nManager } from 'react-native';
import { initReactI18next } from 'react-i18next';
import { AppLanguage, directionForLanguage } from '../core/language';
import { resources } from './translations';

void i18n.use(initReactI18next).init({ resources, lng: 'fr', fallbackLng: 'en', interpolation: { escapeValue: false } });

export async function changeAppLanguage(language: AppLanguage): Promise<void> {
  await i18n.changeLanguage(language);
  const rtl = directionForLanguage(language) === 'rtl';
  I18nManager.allowRTL(rtl);
  I18nManager.forceRTL(rtl);
}

export { i18n };
