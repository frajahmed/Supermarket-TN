import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../core/api-client';
import { isQuantity } from '../../core/orders';
import { normalizeScannedCode, productLabel, trimDecimal, type ProductDetail } from '../../core/products';
import { getApi } from '../../device/session';
import { useLanguage } from '../../i18n/LanguageProvider';
import { BarcodeScanner } from '../BarcodeScanner';
import { Messages, SecondaryButton } from '../components';
import { ui } from '../styles';

type Target = 'barcode' | 'cartonGtin' | null;

export function PackagingEditor({ detail, writable, onChanged }: { detail: ProductDetail; writable: boolean; onChanged: () => void }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const [barcode, setBarcode] = useState('');
  const [factor, setFactor] = useState('');
  const [gtin, setGtin] = useState('');
  const [scanFor, setScanFor] = useState<Target>(null);
  const [message, setMessage] = useState('');
  const id = detail.product.id;
  const unit = t(`units.${detail.product.unit}`);

  async function run(fn: () => Promise<unknown>, reset: () => void) {
    setMessage('');
    try { await fn(); reset(); onChanged(); }
    catch (e) { setMessage(e instanceof ApiError ? e.message : t('errors.serverUnreachable')); }
  }

  function addBarcode() {
    const code = normalizeScannedCode(barcode);
    if (!code) return;
    void run(async () => (await getApi()).post(`/api/v1/products/${id}/barcodes`, { code }), () => setBarcode(''));
  }

  function addCarton() {
    const f = factor.trim().replace(',', '.');
    if (!isQuantity(f)) { setMessage(t('warehouse.errors.invalidQuantity')); return; }
    const n = trimDecimal(f);
    const taken = new Set(detail.packagings.map((p) => p.code));
    const code = taken.has('carton') ? `carton-${n}` : 'carton';
    void run(async () => (await getApi()).post(`/api/v1/products/${id}/packagings`, {
      code, factor: f, name: { fr: `Carton de ${n}`, ar: `كرتونة ${n}`, en: `Carton of ${n}` },
      ...(normalizeScannedCode(gtin) ? { gtin: normalizeScannedCode(gtin) } : {}),
    }), () => { setFactor(''); setGtin(''); });
  }

  const remove = (path: string) => run(async () => (await getApi()).delete(path), () => undefined);

  return (
    <View style={{ gap: 10 }}>
      <Text style={ui.section}>{t('products.packagings')}</Text>
      <View style={ui.card}>
        <Text>1 {unit}</Text>
        {detail.packagings.map((pk) => (
          <View key={pk.id} style={ui.row}>
            <Text style={{ flex: 1 }}>{productLabel(pk.name, language) || pk.code} = {trimDecimal(pk.factor)} {unit}{pk.gtin ? ` · ${pk.gtin}` : ''}</Text>
            {writable ? <Pressable onPress={() => void remove(`/api/v1/products/${id}/packagings/${pk.id}`)}><Text style={ui.error}>{t('orders.remove')}</Text></Pressable> : null}
          </View>
        ))}
        {writable ? (
          <View style={ui.row}>
            <TextInput value={factor} onChangeText={setFactor} keyboardType="decimal-pad" placeholder={t('products.cartonFactor')}
              style={[ui.input, { flexGrow: 0, minWidth: 90 }]} />
            <TextInput value={gtin} onChangeText={setGtin} placeholder={t('products.cartonBarcode')} style={ui.input} />
            <Pressable onPress={() => setScanFor('cartonGtin')}><Text style={ui.link}>{t('products.scan')}</Text></Pressable>
            <SecondaryButton label={t('products.addCarton')} onPress={addCarton} disabled={!factor.trim()} />
          </View>
        ) : null}
      </View>

      <Text style={ui.section}>{t('products.barcodes')}</Text>
      <View style={ui.card}>
        {detail.barcodes.length === 0 ? <Text style={ui.muted}>—</Text> : detail.barcodes.map((b) => (
          <View key={b.code} style={ui.row}>
            <Text style={{ flex: 1 }}>{b.code} · {b.symbology}{b.packQty !== '1.000' ? ` × ${trimDecimal(b.packQty)}` : ''}</Text>
            {writable ? <Pressable onPress={() => void remove(`/api/v1/products/${id}/barcodes/${encodeURIComponent(b.code)}`)}><Text style={ui.error}>{t('orders.remove')}</Text></Pressable> : null}
          </View>
        ))}
        {writable ? (
          <View style={ui.row}>
            <TextInput value={barcode} onChangeText={setBarcode} placeholder={t('products.barcode')} style={ui.input} />
            <Pressable onPress={() => setScanFor('barcode')}><Text style={ui.link}>{t('products.scan')}</Text></Pressable>
            <SecondaryButton label={t('products.addBarcode')} onPress={addBarcode} disabled={!barcode.trim()} />
          </View>
        ) : null}
      </View>
      {scanFor ? (
        <BarcodeScanner onClose={() => setScanFor(null)} onCode={(code) => {
          if (scanFor === 'barcode') setBarcode(code); else setGtin(code);
          setScanFor(null);
        }} />
      ) : null}
      <Messages error={message} />
    </View>
  );
}
