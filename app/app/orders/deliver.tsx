import { useEffect, useRef, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../src/core/api-client';
import { applyScan, deliveryBody, initialPick, remaining, sendOnce, type Order } from '../../src/core/orders';
import { describeScan, productLabel, type BarcodeLookup } from '../../src/core/products';
import { newOpId, secureStore } from '../../src/device/runtime';
import { getApi } from '../../src/device/session';
import { useLanguage } from '../../src/i18n/LanguageProvider';
import { BarcodeScanner } from '../../src/ui/BarcodeScanner';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';
import { BackLink, LoadingScreen, Messages, PrimaryButton, ScreenScroll } from '../../src/ui/components';

export default function DeliverScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile, canWrite } = useProfile();
  const [order, setOrder] = useState<Order | null>(null);
  const [pick, setPick] = useState<Record<string, string>>({});
  const scanned = useRef(new Set<string>());
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState('');
  const [lastLine, setLastLine] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const o = await (await getApi()).get<Order>(`/api/v1/sales-orders/${id}`);
        setOrder(o);
        setPick(initialPick(o));
      } catch {
        setMessage(t('orders.loadFailed'));
      }
    })();
  }, [id, t]);

  async function onScan(code: string) {
    if (!order) return;
    try {
      const r = await (await getApi()).get<BarcodeLookup>(`/api/v1/products/by-barcode/${encodeURIComponent(code)}`);
      const s = describeScan(r, language);
      const result = applyScan(order, pick, s.productId, s.perScan, scanned.current);
      if (result.ok) { setPick(result.pick); setLastLine(result.lineId); setMessage(''); }
      else setMessage(t(`orders.errors.${result.error}`, { product: s.label }));
    } catch (e) {
      setMessage(e instanceof ApiError && e.status === 404 ? t('products.unknownBarcode', { code }) : t('errors.serverUnreachable'));
    }
  }

  async function submit() {
    if (!order) return;
    const check = deliveryBody(order, pick, 'pruefung');
    if (!check.ok) { setMessage(t(`orders.errors.${check.error}`, { product: '' })); setLastLine(check.lineId ?? null); return; }
    setBusy(true); setMessage('');
    try {
      const api = await getApi();
      await sendOnce(secureStore, `delivery:${order.id}`, check.body.lines, newOpId, (opId) =>
        api.post(`/api/v1/sales-orders/${order.id}/deliveries`, { ...check.body, clientOpId: opId }));
      router.back();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : t('orders.sendFailedRetry'));
    } finally {
      setBusy(false);
    }
  }

  if (!order || !profile) {
    return <LoadingScreen error={message} />;
  }
  const writable = canWrite('sales.order');

  return (
    <ScreenScroll>
      <Text style={ui.title}>{t('orders.deliver')} · {order.number}</Text>
      <LicenseBanner profile={profile} />
      <Text style={ui.muted}>{t('orders.pickHint')}</Text>
      {scanning
        ? <BarcodeScanner onCode={(c) => void onScan(c)} onClose={() => setScanning(false)} hint={t('orders.scanToPick')} />
        : <PrimaryButton label={t('orders.pickByScan')} onPress={() => setScanning(true)} />}
      {order.lines.filter((l) => remaining(l) !== '0').map((l) => (
        <View key={l.id} style={[ui.card, lastLine === l.id && { borderColor: '#176b87', borderWidth: 2 }]}>
          <Text style={{ fontWeight: '700' }}>{productLabel(l.productName, language)}</Text>
          <View style={ui.row}>
            <TextInput value={pick[l.id] ?? ''} onChangeText={(v) => setPick((p) => ({ ...p, [l.id]: v }))} keyboardType="decimal-pad"
              style={[ui.input, { flexGrow: 0, minWidth: 90 }]} accessibilityLabel={t('orders.quantity')} />
            <Text>/ {remaining(l)} {t(`units.${l.unit}`)}</Text>
          </View>
        </View>
      ))}
      <Messages error={message} />
      <PrimaryButton label={t('orders.bookDelivery')} onPress={() => void submit()} busy={busy} disabled={!writable} />
      <BackLink />
    </ScreenScroll>
  );
}
