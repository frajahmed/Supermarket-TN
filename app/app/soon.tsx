import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';

export default function SoonScreen() {
  const { t } = useTranslation();
  const { area } = useLocalSearchParams<{ area?: string }>();
  return (
    <SafeAreaView style={styles.safe}><View style={styles.container}>
      {area ? <Text style={styles.title}>{t(`tiles.${area}`)}</Text> : null}
      <Text style={styles.text}>{t('home.comingSoon')}</Text>
      <Pressable onPress={() => router.back()}><Text style={styles.link}>{t('back')}</Text></Pressable>
    </View></SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 }, container: { flex: 1, padding: 24, gap: 16, justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '700', textAlign: 'center' }, text: { textAlign: 'center' }, link: { color: '#176b87', textAlign: 'center' },
});
