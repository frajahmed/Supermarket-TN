import { useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../src/core/api-client';
import { fromMilli, toMilli } from '../../src/core/orders';
import { productLabel, trimDecimal, type LocalizedName } from '../../src/core/products';
import { countMovements, pushOnce, summarize, type PushResult } from '../../src/core/warehouse';
import { newOpId, secureStore } from '../../src/device/runtime';
import { getApi } from '../../src/device/session';
import { useLanguage } from '../../src/i18n/LanguageProvider';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';

interface Item { productId: string; sku: string; name: LocalizedName; unit: string; quantity: string; shelfLocation: string | null }

// Die Differenz bezieht sich auf den Bestand beim Laden der Liste – am besten außerhalb der Öffnungszeiten zählen.
export default function CountScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { profile, storeId, canWrite } = useProfile();
  const [location, setLocation] = useState('');
  const [items, setItems] = useState<Item[] | null>(null);
  const [counted, setCounted] = useState<Record<string, string>>({});
  const [message, setMessage] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  async function loadList() {
    if (!storeId) return;
    setMessage(''); setInfo(''); setBusy(true);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (location.trim()) params.set('location', location.trim());
      const page = await (await getApi()).get<{ items: Item[] }>(`/api/v1/stores/${storeId}/stock?${params.toString()}`);
      setItems(page.items);
      setCounted({});
    } catch {
      setMessage(t('products.loadFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function book() {
    if (!storeId || !items) return;
    setMessage(''); setInfo('');
    const entries = items.map((i) => ({ productId: i.productId, expected: i.quantity, counted: counted[i.productId] ?? '' }));
    const check = countMovements(storeId, entries, () => 'x', new Date());
    if (!check.ok) { setMessage(t(`warehouse.errors.${check.error}`)); return; }
    if (check.movements.length === 0) { setInfo(t('warehouse.noDifferences', { count: check.counted })); return; }
    setBusy(true);
    try {
      const api = await getApi();
      const results = await pushOnce(secureStore, `count:${storeId}`, entries, () => {
        const r = countMovements(storeId, entries, newOpId, new Date());
        return r.ok ? r.movements : [];
      }, async (movements) => (await api.post<{ results: PushResult[] }>('/api/v1/sync/push', { movements })).results);
      const s = summarize(results);
      if (s.rejected.length) setMessage(t('warehouse.partlyRejected', { booked: s.booked, rejected: s.rejected.map((r) => r.error).join('; ') }));
      else { setInfo(t('warehouse.differencesBooked', { count: s.booked })); setItems(null); }
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : t('orders.sendFailedRetry'));
    } finally {
      setBusy(false);
    }
  }

  if (!profile || !storeId) return <SafeAreaView style={ui.safe}><View style={ui.center}><ActivityIndicator /></View></SafeAreaView>;

  return (
    <SafeAreaView style={ui.safe}>
      <ScrollView contentContainerStyle={ui.container} keyboardShouldPersistTaps="handled">
        <Text style={ui.title}>{t('warehouse.count')}</Text>
        <LicenseBanner profile={profile} />
        <Text style={ui.muted}>{t('warehouse.countHint')}</Text>
        <View style={ui.row}>
          <TextInput value={location} onChangeText={setLocation} placeholder={t('warehouse.shelf')} style={ui.input} autoCapitalize="characters" />
          <Pressable style={ui.secondary} onPress={() => void loadList()}><Text style={ui.secondaryText}>{t('warehouse.loadList')}</Text></Pressable>
        </View>
        {items?.map((i) => {
          const c = (counted[i.productId] ?? '').trim().replace(',', '.');
          let diff: string | null = null;
          try { if (c) diff = fromMilli(toMilli(c) - toMilli(i.quantity)); } catch { diff = '?'; }
          return (
            <View key={i.productId} style={ui.card}>
              <Text style={{ fontWeight: '700' }}>{productLabel(i.name, language)}</Text>
              <Text style={ui.muted}>{i.sku}{i.shelfLocation ? ` · ${i.shelfLocation}` : ''} · {t('warehouse.system')}: {trimDecimal(i.quantity)} {t(`units.${i.unit}`)}</Text>
              <View style={ui.row}>
                <TextInput value={counted[i.productId] ?? ''} onChangeText={(v) => setCounted((m) => ({ ...m, [i.productId]: v }))}
                  keyboardType="decimal-pad" placeholder={t('warehouse.counted')} style={[ui.input, { flexGrow: 0, minWidth: 100 }]} />
                {diff && diff !== '0' ? <Text style={[ui.badge, diff.startsWith('-') ? ui.danger : ui.warn]}>{diff.startsWith('-') ? diff : `+${diff}`}</Text> : null}
              </View>
            </View>
          );
        })}
        {items?.length === 0 ? <Text style={ui.muted}>{t('products.empty')}</Text> : null}
        {info ? <Text style={{ color: '#176b87', fontWeight: '700' }}>{info}</Text> : null}
        {message ? <Text style={ui.error} accessibilityRole="alert">{message}</Text> : null}
        {items?.length ? (
          <Pressable style={[ui.primary, (!canWrite('stock.adjust') || busy) && ui.disabled]} disabled={!canWrite('stock.adjust') || busy} onPress={() => void book()}>
            {busy ? <ActivityIndicator color="white" /> : <Text style={ui.primaryText}>{t('warehouse.bookCount')}</Text>}
          </Pressable>
        ) : null}
        <Pressable onPress={() => router.back()}><Text style={ui.link}>{t('back')}</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
