import { useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { tileRoute, tilesFor, type HomeTile } from '../src/core/home';
import { selectStore, signOut } from '../src/device/session';
import { LicenseBanner, useProfile } from '../src/ui/useProfile';

export default function HomeScreen() {
  const { t } = useTranslation();
  const { profile, failed, reload, storeId: initialStore } = useProfile();
  const [chosen, setChosen] = useState<string | null>(null);
  const storeId = chosen ?? initialStore;

  async function chooseStore(id: string) {
    setChosen(id);
    await selectStore(id);
  }

  async function logout() {
    await signOut();
    router.replace('/login');
  }

  function open(tile: HomeTile) {
    const route = tileRoute(tile);
    if (route) router.push(route as never);
    else router.push({ pathname: '/soon', params: { area: tile } });
  }

  if (!profile) {
    return (
      <SafeAreaView style={styles.safe}><View style={styles.center}>
        {failed
          ? <><Text style={styles.error} accessibilityRole="alert">{t('home.loadFailed')}</Text>
              <Pressable style={styles.secondary} onPress={() => void reload(true)}><Text>{t('home.reload')}</Text></Pressable>
              <Pressable onPress={() => void logout()}><Text style={styles.link}>{t('home.logout')}</Text></Pressable></>
          : <ActivityIndicator />}
      </View></SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title}>{t('home.title')}</Text>
            <Text>{profile.user.displayName} · {t(`role.${profile.user.role}`)}</Text>
          </View>
          <Pressable onPress={() => router.push('/account' as never)} accessibilityRole="button"><Text style={styles.link}>{t('account.title')}</Text></Pressable>
          <Pressable onPress={() => void logout()} accessibilityRole="button"><Text style={styles.link}>{t('home.logout')}</Text></Pressable>
        </View>

        <LicenseBanner profile={profile} />

        <Text style={styles.section}>{t('home.store')}</Text>
        {profile.stores.length === 0 ? <Text>{t('home.noStore')}</Text> : (
          <View style={styles.row}>
            {profile.stores.map((s) => (
              <Pressable key={s.id} onPress={() => void chooseStore(s.id)}
                style={[styles.chip, s.id === storeId && styles.chipActive]} accessibilityState={{ selected: s.id === storeId }}>
                <Text style={s.id === storeId ? styles.chipActiveText : undefined}>{s.code} · {s.name}</Text>
              </Pressable>
            ))}
          </View>
        )}

        <View style={styles.grid}>
          {tilesFor(profile.permissions).map((tile) => (
            <Pressable key={tile} style={styles.tile} accessibilityRole="button" onPress={() => open(tile)}>
              <Text style={styles.tileText}>{t(`tiles.${tile}`)}</Text>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 }, container: { padding: 20, gap: 14 }, center: { flex: 1, justifyContent: 'center', alignItems: 'center', gap: 14, padding: 24 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 }, headerText: { flex: 1, gap: 2 },
  title: { fontSize: 26, fontWeight: '700' }, section: { fontWeight: '700', marginTop: 4 },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#999', borderRadius: 16, paddingVertical: 6, paddingHorizontal: 12 },
  chipActive: { backgroundColor: '#176b87', borderColor: '#176b87' }, chipActiveText: { color: 'white', fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 6 },
  tile: { flexBasis: '47%', flexGrow: 1, minHeight: 90, borderRadius: 10, backgroundColor: '#e8f1f4', padding: 14, justifyContent: 'flex-end' },
  tileText: { fontSize: 16, fontWeight: '700', color: '#0f4c5c' },
  secondary: { borderWidth: 1, borderColor: '#999', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 20 },
  error: { color: '#b42318', textAlign: 'center' }, link: { color: '#176b87', textAlign: 'center' },
});
