import { useCallback, useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { ApiClient } from '../src/core/api-client';
import { SignedOutError } from '../src/core/api-client';
import { licenseAllowsWrite, licenseBannerColor, pickStore, tilesFor, type HomeTile } from '../src/core/home';
import { licenseBannerKey, type LicenseMode } from '../src/core/license';
import { createApiClient, loadSelectedStore, saveSelectedStore } from '../src/device/runtime';

interface Profile {
  user: { id: string; email: string; displayName: string; role: 'owner' | 'manager' | 'stock_clerk' | 'cashier' };
  permissions: string[];
  stores: Array<{ id: string; code: string; name: string }>;
  license: { mode: LicenseMode; reason?: string };
}

/** Startseite nach der Anmeldung (T-109): Lizenzbanner, Filiale, Kacheln nach Rechten. */
export default function HomeScreen() {
  const { t } = useTranslation();
  const api = useRef<ApiClient | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [storeId, setStoreId] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      api.current ??= await createApiClient(() => router.replace('/login'));
      if (!api.current) { router.replace('/'); return; }
      const p = await api.current.get<Profile>('/api/v1/me');
      setProfile(p);
      const chosen = pickStore(p.stores, await loadSelectedStore());
      setStoreId(chosen);
      if (chosen) await saveSelectedStore(chosen);
    } catch (e) {
      if (!(e instanceof SignedOutError)) setError(t('home.loadFailed'));
    }
  }, [t]);

  useEffect(() => { void load(); }, [load]);

  async function chooseStore(id: string) {
    setStoreId(id);
    await saveSelectedStore(id);
  }

  async function logout() {
    await api.current?.signOut();
    router.replace('/login');
  }

  if (!profile) {
    return (
      <SafeAreaView style={styles.safe}><View style={styles.center}>
        {error
          ? <><Text style={styles.error} accessibilityRole="alert">{error}</Text>
              <Pressable style={styles.secondary} onPress={() => void load()}><Text>{t('home.reload')}</Text></Pressable>
              <Pressable onPress={() => void logout()}><Text style={styles.link}>{t('home.logout')}</Text></Pressable></>
          : <ActivityIndicator />}
      </View></SafeAreaView>
    );
  }

  const banner = licenseBannerColor(profile.license.mode);
  const tiles = tilesFor(profile.permissions);

  return (
    <SafeAreaView style={styles.safe}>
      <ScrollView contentContainerStyle={styles.container}>
        <View style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.title}>{t('home.title')}</Text>
            <Text>{profile.user.displayName} · {t(`role.${profile.user.role}`)}</Text>
          </View>
          <Pressable onPress={() => void logout()} accessibilityRole="button"><Text style={styles.link}>{t('home.logout')}</Text></Pressable>
        </View>

        {banner ? (
          <View style={[styles.banner, { backgroundColor: banner.background }]} accessibilityRole="alert">
            <Text style={[styles.bannerTitle, { color: banner.text }]}>{t(licenseBannerKey(profile.license.mode))}</Text>
            {!licenseAllowsWrite(profile.license.mode) ? <Text style={{ color: banner.text }}>{t('home.readOnlyHint')}</Text> : null}
          </View>
        ) : null}

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
          {tiles.map((tile: HomeTile) => (
            <Pressable key={tile} style={styles.tile} accessibilityRole="button"
              onPress={() => router.push({ pathname: '/soon', params: { area: tile } })}>
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
  banner: { padding: 14, borderRadius: 8, gap: 4 }, bannerTitle: { fontWeight: '700' },
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { borderWidth: 1, borderColor: '#999', borderRadius: 16, paddingVertical: 6, paddingHorizontal: 12 },
  chipActive: { backgroundColor: '#176b87', borderColor: '#176b87' }, chipActiveText: { color: 'white', fontWeight: '700' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 6 },
  tile: { flexBasis: '47%', flexGrow: 1, minHeight: 90, borderRadius: 10, backgroundColor: '#e8f1f4', padding: 14, justifyContent: 'flex-end' },
  tileText: { fontSize: 16, fontWeight: '700', color: '#0f4c5c' },
  secondary: { borderWidth: 1, borderColor: '#999', borderRadius: 8, paddingVertical: 10, paddingHorizontal: 20 },
  error: { color: '#b42318', textAlign: 'center' }, link: { color: '#176b87', textAlign: 'center' },
});
