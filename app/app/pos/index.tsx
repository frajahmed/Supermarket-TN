import { useEffect, useRef, useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../src/core/api-client';
import { formatTndMinor } from '../../src/core/money';
import { sendOnce } from '../../src/core/orders';
import {
  addToCart, cartTotals, cashSuggestions, lineAmounts, needsApproval, parsePercent, planPayment, saleBody, type CartLine,
} from '../../src/core/pos';
import { describeScan, moneyInputFromMinor, parseMoneyInput, productLabel, type BarcodeLookup, type LocalizedName } from '../../src/core/products';
import { newOpId, secureStore } from '../../src/device/runtime';
import { getApi } from '../../src/device/session';
import { useLanguage } from '../../src/i18n/LanguageProvider';
import { BarcodeScanner } from '../../src/ui/BarcodeScanner';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';

interface StockHit { productId: string; sku: string; name: LocalizedName; unit: string; salePrice: string | null }
interface SaleResult { id: string; receiptNumber: string; grossTotal: string; change: string }

export default function PosScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { profile, storeId, canWrite } = useProfile();
  const [config, setConfig] = useState({ cashierMaxDiscountBp: 500, canApproveDiscount: false });
  const [cart, setCart] = useState<CartLine[]>([]);
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<StockHit[]>([]);
  const [scanning, setScanning] = useState(true);
  const [discountFor, setDiscountFor] = useState<string | null>(null);
  const [discountText, setDiscountText] = useState('');
  const [cash, setCash] = useState('');
  const [card, setCard] = useState('');
  const [approvalEmail, setApprovalEmail] = useState('');
  const [approvalSecret, setApprovalSecret] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SaleResult | null>(null);
  const started = useRef(new Date());

  useEffect(() => {
    void (async () => {
      try { setConfig(await (await getApi()).get('/api/v1/pos/config')); } catch { /* Standardwerte */ }
    })();
  }, []);

  function add(hit: StockHit, quantity = '1') {
    if (!hit.salePrice) { setMessage(t('pos.noPrice', { product: productLabel(hit.name, language) })); return; }
    if (done) newSale();
    setCart((c) => addToCart(c, { productId: hit.productId, label: productLabel(hit.name, language), unit: hit.unit, unitPrice: hit.salePrice! }, quantity));
    setMessage('');
  }

  async function scan(code: string) {
    if (!storeId) return;
    try {
      const api = await getApi();
      const [lookup, stock] = await Promise.all([
        api.get<BarcodeLookup>(`/api/v1/products/by-barcode/${encodeURIComponent(code)}`),
        api.get<{ items: StockHit[] }>(`/api/v1/stores/${storeId}/stock?limit=1&q=${encodeURIComponent(code)}`),
      ]);
      const hit = stock.items[0];
      if (!hit) { setMessage(t('products.unknownBarcode', { code })); return; }
      add(hit, describeScan(lookup, language).perScan);
    } catch (e) {
      setMessage(e instanceof ApiError && e.status === 404 ? t('products.unknownBarcode', { code }) : t('errors.serverUnreachable'));
    }
  }

  async function search() {
    if (!storeId) return;
    try {
      setHits((await (await getApi()).get<{ items: StockHit[] }>(`/api/v1/stores/${storeId}/stock?limit=15&q=${encodeURIComponent(q.trim())}`)).items);
    } catch {
      setMessage(t('products.loadFailed'));
    }
  }

  function setQty(id: string, v: string) {
    setCart((c) => c.map((l) => (l.productId === id ? { ...l, quantity: v.replace(',', '.') } : l)));
  }

  function applyDiscount(id: string) {
    const bp = parsePercent(discountText);
    if (bp === null) { setMessage(t('pos.errors.invalidDiscount')); return; }
    setCart((c) => c.map((l) => (l.productId === id ? { ...l, discountBp: bp } : l)));
    setDiscountFor(null); setDiscountText('');
  }

  function newSale() {
    setCart([]); setCash(''); setCard(''); setDone(null); setMessage(''); setApprovalEmail(''); setApprovalSecret('');
    started.current = new Date();
  }

  const totals = cartTotals(cart);
  const approval = needsApproval(cart, config.cashierMaxDiscountBp, config.canApproveDiscount);

  async function pay() {
    if (!storeId) return;
    setMessage('');
    const plan = planPayment(totals.total, cash, card, parseMoneyInput);
    if (!plan.ok) { setMessage(t(`pos.errors.${plan.error}`)); return; }
    if (approval && (!approvalEmail.trim() || !approvalSecret)) { setMessage(t('pos.errors.approvalRequired')); return; }
    const body = saleBody(storeId, cart, plan.payments, started.current,
      approval ? { email: approvalEmail.trim(), secret: approvalSecret } : undefined);
    if (!body.ok) { setMessage(t(`pos.errors.${body.error}`)); return; }
    setBusy(true);
    try {
      const api = await getApi();
      // Fingerabdruck ohne Freigabe-Passwort (wird nicht gespeichert)
      const { approval: _a, ...fingerprint } = body.body;
      const r = await sendOnce(secureStore, `sale:${storeId}`, fingerprint, newOpId,
        (clientOpId) => api.post<SaleResult>('/api/v1/pos/sales', { ...body.body, clientOpId }));
      setDone(r); setApprovalSecret('');
    } catch (e) {
      if (e instanceof ApiError && (e.body as { code?: string }).code === 'APPROVAL_FAILED') setMessage(t('pos.errors.approvalFailed'));
      else if (e instanceof ApiError && (e.body as { code?: string }).code === 'DISCOUNT_APPROVAL') setMessage(t('pos.errors.approvalRequired'));
      else setMessage(e instanceof ApiError ? e.message : t('orders.sendFailedRetry'));
    } finally {
      setBusy(false);
    }
  }

  if (!profile) return <SafeAreaView style={ui.safe}><View style={ui.center}><ActivityIndicator /></View></SafeAreaView>;
  if (!storeId) return <SafeAreaView style={ui.safe}><View style={ui.center}><Text>{t('home.noStore')}</Text></View></SafeAreaView>;
  const money = (v: string | bigint) => formatTndMinor(String(v), language);

  if (done) {
    return (
      <SafeAreaView style={ui.safe}><View style={ui.center}>
        <Text style={ui.title}>{t('pos.receiptNo', { n: done.receiptNumber })}</Text>
        <Text style={{ fontSize: 20 }}>{t('pos.total')}: {money(done.grossTotal)} TND</Text>
        {done.change !== '0' ? <Text style={{ fontSize: 28, fontWeight: '700', color: '#176b87' }}>{t('pos.change')}: {money(done.change)} TND</Text> : null}
        <Pressable style={ui.secondary} onPress={() => router.push({ pathname: '/documents', params: { kind: 'receipt', id: done.id, number: done.receiptNumber } } as never)}>
          <Text style={ui.secondaryText}>{t('pos.printReceipt')}</Text>
        </Pressable>
        <Pressable style={ui.primary} onPress={newSale}><Text style={ui.primaryText}>{t('pos.nextCustomer')}</Text></Pressable>
      </View></SafeAreaView>
    );
  }

  return (
    <SafeAreaView style={ui.safe}>
      <ScrollView contentContainerStyle={ui.container} keyboardShouldPersistTaps="handled">
        <View style={ui.row}>
          <Text style={[ui.title, { flex: 1 }]}>{t('tiles.pos')}</Text>
          <Pressable onPress={() => router.push('/pos/receipts' as never)}><Text style={ui.link}>{t('pos.receipts')}</Text></Pressable>
        </View>
        <LicenseBanner profile={profile} />
        {scanning ? <BarcodeScanner onCode={(c) => void scan(c)} onClose={() => setScanning(false)} hint={t('pos.scanHint')} /> : (
          <Pressable style={ui.secondary} onPress={() => setScanning(true)}><Text style={ui.secondaryText}>{t('products.scan')}</Text></Pressable>
        )}
        <View style={ui.row}>
          <TextInput value={q} onChangeText={setQ} placeholder={t('products.search')} style={ui.input} returnKeyType="search" onSubmitEditing={() => void search()} />
        </View>
        {hits.map((h) => (
          <Pressable key={h.productId} style={ui.card} onPress={() => { add(h); setHits([]); setQ(''); }}>
            <Text style={{ fontWeight: '700' }}>{productLabel(h.name, language)}</Text>
            <Text style={ui.muted}>{h.sku} · {h.salePrice ? `${money(h.salePrice)} TND` : t('pos.noPriceShort')}</Text>
          </Pressable>
        ))}

        {cart.map((l) => {
          const a = (() => { try { return lineAmounts(l); } catch { return null; } })();
          return (
            <View key={l.productId} style={ui.card}>
              <View style={ui.row}>
                <Text style={{ fontWeight: '700', flex: 1 }}>{l.label}</Text>
                <Text style={{ fontWeight: '700' }}>{a ? money(a.total) : '?'}</Text>
              </View>
              <View style={ui.row}>
                <TextInput value={l.quantity} onChangeText={(v) => setQty(l.productId, v)} keyboardType="decimal-pad"
                  style={[ui.input, { flexGrow: 0, minWidth: 70 }]} accessibilityLabel={t('orders.quantity')} />
                <Text>× {money(l.unitPrice)}</Text>
                {l.discountBp ? <Text style={[ui.badge, l.discountBp > config.cashierMaxDiscountBp ? ui.danger : ui.warn]}>−{l.discountBp / 100} %</Text> : null}
                <Pressable onPress={() => { setDiscountFor(l.productId); setDiscountText(l.discountBp ? String(l.discountBp / 100) : ''); }}>
                  <Text style={ui.link}>{t('pos.discount')}</Text>
                </Pressable>
                <Pressable onPress={() => setCart((c) => c.filter((x) => x.productId !== l.productId))}><Text style={ui.error}>{t('orders.remove')}</Text></Pressable>
              </View>
              {discountFor === l.productId ? (
                <View style={ui.row}>
                  <TextInput value={discountText} onChangeText={setDiscountText} keyboardType="decimal-pad" placeholder="%" style={[ui.input, { flexGrow: 0, minWidth: 70 }]} />
                  <Pressable style={ui.secondary} onPress={() => applyDiscount(l.productId)}><Text style={ui.secondaryText}>OK</Text></Pressable>
                  <Text style={ui.muted}>{t('pos.limit', { limit: config.cashierMaxDiscountBp / 100 })}</Text>
                </View>
              ) : null}
            </View>
          );
        })}

        {cart.length ? (
          <View style={[ui.card, { gap: 10, borderColor: '#176b87' }]}>
            <Text style={{ fontSize: 24, fontWeight: '700' }}>{t('pos.total')}: {money(totals.total)} TND</Text>
            {totals.discount !== '0' ? <Text style={ui.muted}>{t('pos.discountTotal')}: {money(totals.discount)}</Text> : null}
            <Text>{t('pos.cashGiven')}</Text>
            <View style={ui.row}>
              {cashSuggestions(totals.total).map((s) => (
                <Pressable key={s} style={[ui.chip, parseMoneyInput(cash) === s && ui.chipActive]} onPress={() => setCash(moneyInputFromMinor(s))}>
                  <Text style={parseMoneyInput(cash) === s ? ui.chipActiveText : undefined}>{money(s)}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput value={cash} onChangeText={setCash} keyboardType="decimal-pad" placeholder={t('pos.cash')} style={ui.input} />
            <TextInput value={card} onChangeText={setCard} keyboardType="decimal-pad" placeholder={t('pos.card')} style={ui.input} />
            {(() => {
              const p = planPayment(totals.total, cash, card, parseMoneyInput);
              return p.ok && p.change !== '0' ? <Text style={{ fontSize: 20, fontWeight: '700', color: '#176b87' }}>{t('pos.change')}: {money(p.change)} TND</Text> : null;
            })()}
            {approval ? (
              <View style={{ gap: 6 }}>
                <Text style={ui.error}>{t('pos.approvalNeeded', { limit: config.cashierMaxDiscountBp / 100 })}</Text>
                <TextInput value={approvalEmail} onChangeText={setApprovalEmail} placeholder={t('pos.approverEmail')} style={ui.input}
                  autoCapitalize="none" keyboardType="email-address" />
                <TextInput value={approvalSecret} onChangeText={setApprovalSecret} placeholder={t('pos.approverSecret')} style={ui.input} secureTextEntry />
              </View>
            ) : null}
            {message ? <Text style={ui.error} accessibilityRole="alert">{message}</Text> : null}
            <Pressable style={[ui.primary, (!canWrite('sale.create') || busy) && ui.disabled]} disabled={!canWrite('sale.create') || busy} onPress={() => void pay()}>
              {busy ? <ActivityIndicator color="white" /> : <Text style={[ui.primaryText, { fontSize: 18 }]}>{t('pos.pay')}</Text>}
            </Pressable>
            <Pressable onPress={newSale}><Text style={ui.link}>{t('pos.cancelSale')}</Text></Pressable>
          </View>
        ) : (
          <>
            <Text style={ui.muted}>{t('pos.emptyCart')}</Text>
            {message ? <Text style={ui.error}>{message}</Text> : null}
          </>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}
