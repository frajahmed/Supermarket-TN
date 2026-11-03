import { Stack } from 'expo-router';
import { I18nextProvider } from 'react-i18next';
import { i18n } from '../src/i18n';
import { LanguageProvider } from '../src/i18n/LanguageProvider';

export default function Layout() {
  return (
    <I18nextProvider i18n={i18n}>
      <LanguageProvider>
        <Stack />
      </LanguageProvider>
    </I18nextProvider>
  );
}
