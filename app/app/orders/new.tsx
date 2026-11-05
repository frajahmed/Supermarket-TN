import { useState } from 'react';
import { router } from 'expo-router';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../src/core/api-client';
import type { Customer } from '../../src/core/customers';
import { addToDraft, baseQuantity, orderBody, sendOnce, type DraftError, type DraftLine, type Order } from '../../src/core/orders';
import { describeScan, productLabel, trimDecimal, type BarcodeLookup, type LocalizedName } from '../../src/core/products';
import { newOpId, secureStore } from '../../src/device/runtime';
import { getApi } from '../../src/device/session';
import { useLanguage } from '../../src/i18n/LanguageProvider';
import { BarcodeScanner } from '../../src/ui/BarcodeScanner';
import { CustomerPicker } from '../../src/ui/CustomerPicker';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';
import { BackLink, LoadingScreen, Messages, PrimaryButton, ScreenScroll } from '../../src/ui/components';

interface StockHit { productId: string; sku: string; name: LocalizedName; unit: string; quantity: string }

export default function NewOrderScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { profile, storeId, canWrite } = useProfile();
  const [customer, setCustomer] = useState<Customer | null>(null);
  const [productQuery, setProductQuery] = useState('');
  const [productHits, setProductHits] = useState<StockHit[]>([]);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [note, setNote] = useState('');
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState('');
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function findProducts() {
    if (!storeId) return;
    setMessage('');
    try {
      const q = encodeURIComponent(productQuery.trim());
      setProductHits((await (await getApi()).get<{ items: StockHit[] }>(`/api/v1/stores/${storeId}/stock?limit=20${q ? `&q=${q}` : ''}`)).items);
    } catch {
      setMessage(t('products.loadFailed'));
    }
  }

  async function onScan(code: string) {
    setMessage('');
    try {
      const r = await (await getApi()).get<BarcodeLookup>(`/api/v1/products/by-barcode/${encodeURIComponent(code)}`);
      const s = describeScan(r, language);
      setLines((ls) => addToDraft(ls, {
        productId: s.productId, label: s.label, unit: r.product.unit, factor: r.packaging ? r.packaging.factor : '1',
        ...(r.packaging ? { packagingId: r.packaging.id, packagingLabel: s.packagingLabel ?? r.packaging.code } : {}),
      }));
    } catch (e) {
      setMessage(e instanceof ApiError && e.status === 404 ? t('products.unknownBarcode', { code }) : t('errors.serverUnreachable'));
    }
  }

  function setQty(key: string, quantity: string) {
    setLines((ls) => ls.map((l) => (l.key === key ? { ...l, quantity: quantity.replace(',', '.') } : l)));
  }

  async function create() {
    if (!storeId) return;
    setMessage(''); setErrorKey(null);
    const check = orderBody({ storeId, customerId: customer?.id ?? null, lines, note }, 'pruefung');
    if (!check.ok) { setMessage(t(`orders.errors.${check.error satisfies DraftError}`)); setErrorKey(check.lineKey ?? null); return; }
    setBusy(true);
    try {
      const api = await getApi();
      const order = await sendOnce(secureStore, `order:${storeId}`, check.body, newOpId, (opId) => {
        const r = orderBody({ storeId, customerId: customer?.id ?? null, lines, note }, opId);
        if (!r.ok) throw new Error(r.error);
        return api.post<Order>('/api/v1/sales-orders', r.body);
      });
      router.replace({ pathname: '/orders/[id]', params: { id: order.id } } as never);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : t('orders.sendFailedRetry'));
    } finally {
      setBusy(false);
    }
  }

  if (!profile) return <LoadingScreen />;
  const writable = canWrite('sales.order');

  return (
    <ScreenScroll>
      <Text style={ui.title}>{t('orders.new')}</Text>
      <LicenseBanner profile={profile} />

      <Text style={ui.section}>1. {t('orders.customer')}</Text>
      <CustomerPicker value={customer} onChange={setCustomer} onError={setMessage} />

      <Text style={ui.section}>2. {t('orders.items')}</Text>
      {scanning
        ? <BarcodeScanner onCode={(code) => void onScan(code)} onClose={() => setScanning(false)} hint={t('orders.scanToAdd')} />
        : (
          <View style={ui.row}>
            <TextInput value={productQuery} onChangeText={setProductQuery} placeholder={t('products.search')} style={ui.input}
              returnKeyType="search" onSubmitEditing={() => void findProducts()} />
            <PrimaryButton label={t('products.scan')} onPress={() => setScanning(true)} />
          </View>
        )}
      {productHits.map((p) => (
        <Pressable key={p.productId} style={ui.card} onPress={() => {
          setLines((ls) => addToDraft(ls, { productId: p.productId, label: productLabel(p.name, language), unit: p.unit, factor: '1' }));
          setProductHits([]); setProductQuery('');
        }}>
          <Text style={{ fontWeight: '700' }}>{productLabel(p.name, language)}</Text>
          <Text style={ui.muted}>{p.sku} · {t('products.stock')}: {trimDecimal(p.quantity)} {t(`units.${p.unit}`)}</Text>
        </Pressable>
      ))}

      {lines.map((l) => (
        <View key={l.key} style={[ui.card, errorKey === l.key && { borderColor: '#b42318' }]}>
          <Text style={{ fontWeight: '700' }}>{l.label}</Text>
          <View style={ui.row}>
            <TextInput value={l.quantity} onChangeText={(v) => setQty(l.key, v)} keyboardType="decimal-pad"
              style={[ui.input, { flexGrow: 0, minWidth: 80 }]} accessibilityLabel={t('orders.quantity')} />
            <Text>{l.packagingLabel ?? t(`units.${l.unit}`)}</Text>
            {l.packagingId ? <Text style={ui.muted}>= {(() => { try { return baseQuantity(l); } catch { return '?'; } })()} {t(`units.${l.unit}`)}</Text> : null}
            <Pressable onPress={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}><Text style={ui.error}>{t('orders.remove')}</Text></Pressable>
          </View>
        </View>
      ))}

      <Text style={ui.section}>3. {t('orders.note')}</Text>
      <TextInput value={note} onChangeText={setNote} style={[ui.input, { minHeight: 60 }]} multiline maxLength={1000} />

      <Text style={ui.muted}>{t('orders.priceHint')}</Text>
      <Messages error={message} />
      <PrimaryButton label={t('orders.createDraft')} onPress={() => void create()} busy={busy} disabled={!writable} />
      <BackLink />
    </ScreenScroll>
  );
}
