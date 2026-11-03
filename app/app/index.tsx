import { useEffect, useState } from 'react';
import { Link } from 'expo-router';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { LANGUAGES } from '../src/core/language';
import { hasDeviceCertificate } from '../src/device/runtime';
import { useLanguage } from '../src/i18n/LanguageProvider';

const LANGUAGE_LABEL = { ar: 'العربية', fr: 'Français', en: 'English' } as const;

export default function HomeScreen() {
  const { t } = useTranslation();
  const { language, setLanguage } = useLanguage();
  const [activated, setActivated] = useState<boolean | null>(null);

  useEffect(() => {
    void hasDeviceCertificate().then(setActivated).catch(() => setActivated(false));
  }, []);

  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Text style={styles.title}>{t('appName')}</Text>
        <Text style={styles.subtitle}>{t('language')}</Text>
        <View style={styles.row}>
          {LANGUAGES.map((code) => (
            <Pressable key={code} accessibilityRole="button" accessibilityState={{ selected: code === language }}
              style={[styles.language, code === language && styles.languageActive]} onPress={() => void setLanguage(code)}>
              <Text>{LANGUAGE_LABEL[code]}</Text>
            </Pressable>
          ))}
        </View>
        {activated === false ? (
          <Link href="/setup" asChild>
            <Pressable style={styles.primary}><Text style={styles.primaryText}>{t('setup')}</Text></Pressable>
          </Link>
        ) : null}
        {activated ? (
          <Link href="/login" asChild>
            <Pressable style={styles.primary}><Text style={styles.primaryText}>{t('login')}</Text></Pressable>
          </Link>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 }, container: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
  title: { fontSize: 32, fontWeight: '700', textAlign: 'center' }, subtitle: { textAlign: 'center' },
  row: { flexDirection: 'row', justifyContent: 'center', gap: 8 },
  language: { borderWidth: 1, borderColor: '#999', borderRadius: 6, paddingVertical: 10, paddingHorizontal: 14 },
  languageActive: { borderColor: '#176b87', borderWidth: 2 },
  primary: { backgroundColor: '#176b87', borderRadius: 8, padding: 14, alignItems: 'center' },
  primaryText: { color: 'white', fontWeight: '700' },
});
