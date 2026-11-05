import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../core/api-client';
import { sendOnce } from '../../core/orders';
import { addToCart, cartTotals, needsApproval, planPayment, saleBody, type CartLine } from '../../core/pos';
import { describeScan, parseMoneyInput, productLabel, type BarcodeLookup, type LocalizedName } from '../../core/products';
import { newOpId, secureStore } from '../../device/runtime';
import { getApi } from '../../device/session';
import { useLanguage } from '../../i18n/LanguageProvider';

export interface StockHit { productId: string; sku: string; name: LocalizedName; unit: string; salePrice: string | null }
export interface SaleResult { id: string; receiptNumber: string; grossTotal: string; change: string }
export interface PosConfig { cashierMaxDiscountBp: number; canApproveDiscount: boolean }

export function usePosSale(storeId: string | null) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const [config, setConfig] = useState<PosConfig>({ cashierMaxDiscountBp: 500, canApproveDiscount: false });
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cash, setCash] = useState('');
  const [card, setCard] = useState('');
  const [approval, setApproval] = useState({ email: '', secret: '' });
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<SaleResult | null>(null);
  const started = useRef(new Date());

  useEffect(() => {
    void (async () => {
      try { setConfig(await (await getApi()).get<PosConfig>('/api/v1/pos/config')); } catch { /* Standardwerte bleiben */ }
    })();
  }, []);

  function reset() {
    setCart([]); setCash(''); setCard(''); setDone(null); setMessage(''); setApproval({ email: '', secret: '' });
    started.current = new Date();
  }

  function add(hit: StockHit, quantity = '1') {
    if (!hit.salePrice) { setMessage(t('pos.noPrice', { product: productLabel(hit.name, language) })); return; }
    if (done) reset();
    const price = hit.salePrice;
    setCart((c) => addToCart(c, { productId: hit.productId, label: productLabel(hit.name, language), unit: hit.unit, unitPrice: price }, quantity));
    setMessage('');
  }

  // Der Barcode liefert die Menge je Scan (Karton), die Bestandsliste den Filialpreis.
  async function scan(code: string) {
    if (!storeId) return;
    try {
      const api = await getApi();
      const [lookup, stock] = await Promise.all([
        api.get<BarcodeLookup>(`/api/v1/products/by-barcode/${encodeURIComponent(code)}`),
        api.get<{ items: StockHit[] }>(`/api/v1/stores/${storeId}/stock?limit=1&q=${encodeURIComponent(code)}`),
      ]);
      const hit = stock.items[0];
      if (hit) add(hit, describeScan(lookup, language).perScan);
      else setMessage(t('products.unknownBarcode', { code }));
    } catch (e) {
      setMessage(e instanceof ApiError && e.status === 404 ? t('products.unknownBarcode', { code }) : t('errors.serverUnreachable'));
    }
  }

  async function search(query: string): Promise<StockHit[]> {
    if (!storeId) return [];
    try {
      return (await (await getApi()).get<{ items: StockHit[] }>(`/api/v1/stores/${storeId}/stock?limit=15&q=${encodeURIComponent(query.trim())}`)).items;
    } catch {
      setMessage(t('products.loadFailed'));
      return [];
    }
  }

  const updateLine = (productId: string, patch: Partial<CartLine>) =>
    setCart((c) => c.map((l) => (l.productId === productId ? { ...l, ...patch } : l)));
  const removeLine = (productId: string) => setCart((c) => c.filter((l) => l.productId !== productId));

  const totals = cartTotals(cart);
  const approvalNeeded = needsApproval(cart, config.cashierMaxDiscountBp, config.canApproveDiscount);
  const preview = planPayment(totals.total, cash, card, parseMoneyInput);

  async function pay() {
    if (!storeId) return;
    setMessage('');
    if (!preview.ok) { setMessage(t(`pos.errors.${preview.error}`)); return; }
    if (approvalNeeded && (!approval.email.trim() || !approval.secret)) { setMessage(t('pos.errors.approvalRequired')); return; }
    const body = saleBody(storeId, cart, preview.payments, started.current,
      approvalNeeded ? { email: approval.email.trim(), secret: approval.secret } : undefined);
    if (!body.ok) { setMessage(t(`pos.errors.${body.error}`)); return; }
    setBusy(true);
    try {
      const api = await getApi();
      // Das Freigabe-Passwort darf nicht im gespeicherten Fingerabdruck landen.
      const { approval: _secret, ...fingerprint } = body.body;
      setDone(await sendOnce(secureStore, `sale:${storeId}`, fingerprint, newOpId,
        (clientOpId) => api.post<SaleResult>('/api/v1/pos/sales', { ...body.body, clientOpId })));
      setApproval((a) => ({ ...a, secret: '' }));
    } catch (e) {
      const code = e instanceof ApiError ? (e.body as { code?: string }).code : undefined;
      if (code === 'APPROVAL_FAILED') setMessage(t('pos.errors.approvalFailed'));
      else if (code === 'DISCOUNT_APPROVAL') setMessage(t('pos.errors.approvalRequired'));
      else setMessage(e instanceof ApiError ? e.message : t('orders.sendFailedRetry'));
    } finally {
      setBusy(false);
    }
  }

  return {
    config, cart, totals, preview, cash, setCash, card, setCard, approval, setApproval, approvalNeeded,
    message, setMessage, busy, done, add, scan, search, updateLine, removeLine, pay, reset,
  };
}
