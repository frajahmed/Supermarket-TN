import { Link } from 'expo-router';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { changeAppLanguage } from '../src/i18n';

export default function HomeScreen() {
  const { t } = useTranslation();
  return (
    <SafeAreaView style={styles.safe}>
      <View style={styles.container}>
        <Text style={styles.title}>{t('appName')}</Text>
        <Text style={styles.subtitle}>{t('language')}</Text>
        <View style={styles.row}>
          {(['fr', 'ar', 'en'] as const).map((language) => (
            <Pressable key={language} style={styles.language} onPress={() => void changeAppLanguage(language)}>
              <Text>{language.toUpperCase()}</Text>
            </Pressable>
          ))}
        </View>
        <Link href="/setup" asChild>
          <Pressable style={styles.primary}><Text style={styles.primaryText}>{t('setup')}</Text></Pressable>
        </Link>
        <Link href="/login" asChild>
          <Pressable style={styles.secondary}><Text>{t('login')}</Text></Pressable>
        </Link>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 }, container: { flex: 1, justifyContent: 'center', padding: 24, gap: 16 },
  title: { fontSize: 32, fontWeight: '700', textAlign: 'center' }, subtitle: { textAlign: 'center' },
  row: { flexDirection: 'row', justifyContent: 'center', gap: 8 }, language: { borderWidth: 1, borderRadius: 6, padding: 10 },
  primary: { backgroundColor: '#176b87', borderRadius: 8, padding: 14, alignItems: 'center' },
  primaryText: { color: 'white', fontWeight: '700' }, secondary: { borderWidth: 1, borderRadius: 8, padding: 14, alignItems: 'center' },
});
