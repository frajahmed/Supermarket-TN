import { useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../src/core/api-client';
import type { ProductDetail } from '../../src/core/products';
import { pushOnce, receiptMovement, summarize, type Movement, type PushResult } from '../../src/core/warehouse';
import { newOpId, secureStore } from '../../src/device/runtime';
import { getApi } from '../../src/device/session';
import { ProductPicker, type PickedProduct } from '../../src/ui/ProductPicker';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';

interface Line { product: PickedProduct; trackExpiry: boolean; packs: string; expiry: string; lotNumber: string }

/** Wareneingang (T-113): Produkt scannen, Menge (Gebinde), MHD und Charge; Stapel bucht genau einmal. */
export default function ReceiveScreen() {
  const { t } = useTranslation();
  const { profile, storeId, canWrite } = useProfile();
  const [lines, setLines] = useState<Line[]>([]);
  const [message, setMessage] = useState('');
  const [info, setInfo] = useState('');
  const [errorIndex, setErrorIndex] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  async function add(p: PickedProduct) {
    try {
      const d = await (await getApi()).get<ProductDetail>(`/api/v1/products/${p.productId}`);
      setLines((ls) => [...ls, { product: p, trackExpiry: d.product.trackExpiry, packs: '1', expiry: '', lotNumber: '' }]);
    } catch {
      setMessage(t('products.loadFailed'));
    }
  }

  const update = (i: number, patch: Partial<Line>) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function book() {
    if (!storeId || !lines.length) return;
    setMessage(''); setInfo(''); setErrorIndex(null);
    const now = new Date();
    const build = (): Movement[] => lines.map((l) => {
      const r = receiptMovement({ storeId, productId: l.product.productId, packs: l.packs, factor: l.product.packaging?.factor ?? '1',
        packaged: Boolean(l.product.packaging), trackExpiry: l.trackExpiry, expiry: l.expiry, lotNumber: l.lotNumber,
        clientOpId: newOpId(), now });
      if (!r.ok) throw Object.assign(new Error(r.error), { kind: r.error });
      return r.movement;
    });
    // Vorabprüfung je Zeile für eine genaue Fehlermeldung
    for (const [i, l] of lines.entries()) {
      const r = receiptMovement({ storeId, productId: l.product.productId, packs: l.packs, factor: l.product.packaging?.factor ?? '1',
        packaged: Boolean(l.product.packaging), trackExpiry: l.trackExpiry, expiry: l.expiry, lotNumber: l.lotNumber, clientOpId: 'x', now });
      if (!r.ok) { setMessage(t(`warehouse.errors.${r.error}`)); setErrorIndex(i); return; }
    }
    setBusy(true);
    try {
      const api = await getApi();
      const content = lines.map((l) => [l.product.productId, l.product.packaging?.id, l.packs, l.expiry, l.lotNumber]);
      const results = await pushOnce(secureStore, `receive:${storeId}`, content, build,
        async (movements) => (await api.post<{ results: PushResult[] }>('/api/v1/sync/push', { movements })).results);
      const s = summarize(results);
      if (s.rejected.length) setMessage(t('warehouse.partlyRejected', { booked: s.booked, rejected: s.rejected.map((r) => r.error).join('; ') }));
      else { setLines([]); setInfo(t('warehouse.booked', { count: s.booked })); }
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
        <Text style={ui.title}>{t('warehouse.receive')}</Text>
        <LicenseBanner profile={profile} />
        <ProductPicker storeId={storeId} onPick={(p) => void add(p)} />
        {lines.map((l, i) => (
          <View key={`${l.product.productId}-${i}`} style={[ui.card, { gap: 8 }, errorIndex === i && { borderColor: '#b42318' }]}>
            <View style={ui.row}>
              <Text style={{ fontWeight: '700', flex: 1 }}>{l.product.label}</Text>
              <Pressable onPress={() => setLines((ls) => ls.filter((_, j) => j !== i))}><Text style={ui.error}>{t('orders.remove')}</Text></Pressable>
            </View>
            <View style={ui.row}>
              <TextInput value={l.packs} onChangeText={(v) => update(i, { packs: v })} keyboardType="decimal-pad"
                style={[ui.input, { flexGrow: 0, minWidth: 80 }]} accessibilityLabel={t('orders.quantity')} />
              <Text>{l.product.packaging ? `${l.product.packaging.label} (× ${l.product.packaging.factor.replace(/\.?0+$/u, '')})` : t(`units.${l.product.unit}`)}</Text>
            </View>
            <View style={ui.row}>
              <TextInput value={l.expiry} onChangeText={(v) => update(i, { expiry: v })} placeholder={t('warehouse.expiryPlaceholder')}
                style={ui.input} keyboardType="numbers-and-punctuation" accessibilityLabel={t('warehouse.expiry')} />
              <TextInput value={l.lotNumber} onChangeText={(v) => update(i, { lotNumber: v })} placeholder={t('warehouse.lotNumber')}
                style={ui.input} autoCapitalize="characters" />
            </View>
            {l.trackExpiry ? <Text style={ui.muted}>{t('warehouse.expiryRequired')}</Text> : null}
          </View>
        ))}
        {info ? <Text style={{ color: '#176b87', fontWeight: '700' }}>{info}</Text> : null}
        {message ? <Text style={ui.error} accessibilityRole="alert">{message}</Text> : null}
        <Pressable style={[ui.primary, (!canWrite('stock.receive') || busy || !lines.length) && ui.disabled]}
          disabled={!canWrite('stock.receive') || busy || !lines.length} onPress={() => void book()}>
          {busy ? <ActivityIndicator color="white" /> : <Text style={ui.primaryText}>{t('warehouse.bookReceipt')}</Text>}
        </Pressable>
        <Pressable onPress={() => router.back()}><Text style={ui.link}>{t('back')}</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
