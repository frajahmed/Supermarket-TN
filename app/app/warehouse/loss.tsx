import { useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../src/core/api-client';
import { trimDecimal, type ProductDetail } from '../../src/core/products';
import { LOSS_REASONS, lossMovement, pushOnce, summarize, type LossReason, type PushResult } from '../../src/core/warehouse';
import { newOpId, secureStore } from '../../src/device/runtime';
import { getApi } from '../../src/device/session';
import { ProductPicker, type PickedProduct } from '../../src/ui/ProductPicker';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';

export default function LossScreen() {
  const { t } = useTranslation();
  const { profile, storeId, canWrite } = useProfile();
  const [product, setProduct] = useState<PickedProduct | null>(null);
  const [lots, setLots] = useState<NonNullable<ProductDetail['stock']>['lots']>([]);
  const [lotId, setLotId] = useState<string | undefined>(undefined);
  const [quantity, setQuantity] = useState('1');
  const [reason, setReason] = useState<LossReason | null>(null);
  const [note, setNote] = useState('');
  const [message, setMessage] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  async function pick(p: PickedProduct) {
    setProduct(p); setLotId(undefined); setInfo(''); setMessage('');
    if (p.packaging) setQuantity(trimDecimal(p.packaging.factor));
    try {
      const d = await (await getApi()).get<ProductDetail>(`/api/v1/products/${p.productId}?storeId=${storeId}`);
      setLots(d.stock?.lots ?? []);
    } catch {
      setLots([]);
    }
  }

  async function book() {
    if (!storeId || !product) return;
    setMessage(''); setInfo('');
    const input = { storeId, productId: product.productId, quantity, reason, note, lotId };
    const check = lossMovement({ ...input, clientOpId: 'x', now: new Date() });
    if (!check.ok) { setMessage(t(`warehouse.errors.${check.error}`)); return; }
    setBusy(true);
    try {
      const api = await getApi();
      const results = await pushOnce(secureStore, `loss:${storeId}`, input, () => {
        const r = lossMovement({ ...input, clientOpId: newOpId(), now: new Date() });
        return r.ok ? [r.movement] : [];
      }, async (movements) => (await api.post<{ results: PushResult[] }>('/api/v1/sync/push', { movements })).results);
      const s = summarize(results);
      if (s.rejected.length) setMessage(s.rejected.map((r) => r.error).join('; '));
      else { setInfo(t('warehouse.lossBooked')); setProduct(null); setReason(null); setNote(''); setQuantity('1'); }
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : t('orders.sendFailedRetry'));
    } finally {
      setBusy(false);
    }
  }

  if (!profile || !storeId) return <SafeAreaView style={ui.safe}><View style={ui.center}><ActivityIndicator /></View></SafeAreaView>;
  const reasonMissing = !reason || (reason === 'other' && !note.trim());

  return (
    <SafeAreaView style={ui.safe}>
      <ScrollView contentContainerStyle={ui.container} keyboardShouldPersistTaps="handled">
        <Text style={ui.title}>{t('warehouse.loss')}</Text>
        <LicenseBanner profile={profile} />
        {product ? (
          <View style={[ui.card, ui.row]}>
            <Text style={{ flex: 1, fontWeight: '700' }}>{product.label}</Text>
            <Pressable onPress={() => setProduct(null)}><Text style={ui.link}>{t('orders.change')}</Text></Pressable>
          </View>
        ) : <ProductPicker storeId={storeId} onPick={(p) => void pick(p)} />}

        {product ? (
          <>
            <View style={ui.row}>
              <TextInput value={quantity} onChangeText={setQuantity} keyboardType="decimal-pad" style={[ui.input, { flexGrow: 0, minWidth: 90 }]}
                accessibilityLabel={t('orders.quantity')} />
              <Text>{t(`units.${product.unit}`)}</Text>
            </View>
            {lots.length ? (
              <>
                <Text>{t('warehouse.fromLot')}</Text>
                <View style={ui.row}>
                  {lots.map((l) => (
                    <Pressable key={l.id} style={[ui.chip, lotId === l.id && ui.chipActive]} onPress={() => setLotId(lotId === l.id ? undefined : l.id)}>
                      <Text style={lotId === l.id ? ui.chipActiveText : undefined}>{l.lotNumber ?? '—'} · {l.expiryDate ?? ''} · {trimDecimal(l.quantity)}</Text>
                    </Pressable>
                  ))}
                </View>
              </>
            ) : null}
            <Text>{t('warehouse.reason')} *</Text>
            <View style={ui.row}>
              {LOSS_REASONS.map((r) => (
                <Pressable key={r} style={[ui.chip, reason === r && ui.chipActive]} onPress={() => setReason(r)}>
                  <Text style={reason === r ? ui.chipActiveText : undefined}>{t(`warehouse.reasons.${r}`)}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput value={note} onChangeText={setNote} placeholder={reason === 'other' ? `${t('warehouse.note')} *` : t('warehouse.note')}
              style={ui.input} maxLength={400} />
          </>
        ) : null}
        {info ? <Text style={{ color: '#176b87', fontWeight: '700' }}>{info}</Text> : null}
        {message ? <Text style={ui.error} accessibilityRole="alert">{message}</Text> : null}
        <Pressable style={[ui.primary, (!canWrite('stock.adjust') || busy || !product || reasonMissing) && ui.disabled]}
          disabled={!canWrite('stock.adjust') || busy || !product || reasonMissing} onPress={() => void book()}>
          {busy ? <ActivityIndicator color="white" /> : <Text style={ui.primaryText}>{t('warehouse.bookLoss')}</Text>}
        </Pressable>
        <Pressable onPress={() => router.back()}><Text style={ui.link}>{t('back')}</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
