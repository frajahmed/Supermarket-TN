import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../core/api-client';
import { describeScan, productLabel, trimDecimal, type BarcodeLookup, type LocalizedName } from '../core/products';
import { getApi } from '../device/session';
import { useLanguage } from '../i18n/LanguageProvider';
import { BarcodeScanner } from './BarcodeScanner';
import { ui } from './styles';

export interface PickedProduct {
  productId: string; label: string; unit: string;
  packaging: { id: string; label: string; factor: string } | null;
}

export function ProductPicker({ storeId, onPick }: { storeId: string; onPick: (p: PickedProduct) => void }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Array<{ productId: string; sku: string; name: LocalizedName; unit: string; quantity: string }>>([]);
  const [scanning, setScanning] = useState(false);
  const [message, setMessage] = useState('');

  async function search() {
    setMessage('');
    try {
      const query = encodeURIComponent(q.trim());
      setHits((await (await getApi()).get<{ items: typeof hits }>(`/api/v1/stores/${storeId}/stock?limit=20${query ? `&q=${query}` : ''}`)).items);
    } catch {
      setMessage(t('products.loadFailed'));
    }
  }

  async function scan(code: string) {
    setMessage('');
    try {
      const r = await (await getApi()).get<BarcodeLookup>(`/api/v1/products/by-barcode/${encodeURIComponent(code)}`);
      const s = describeScan(r, language);
      setScanning(false);
      onPick({ productId: s.productId, label: s.label, unit: r.product.unit,
        packaging: r.packaging ? { id: r.packaging.id, label: s.packagingLabel ?? r.packaging.code, factor: r.packaging.factor } : null });
    } catch (e) {
      setMessage(e instanceof ApiError && e.status === 404 ? t('products.unknownBarcode', { code }) : t('errors.serverUnreachable'));
    }
  }

  return (
    <View style={{ gap: 8 }}>
      {scanning ? <BarcodeScanner onCode={(c) => void scan(c)} onClose={() => setScanning(false)} /> : (
        <View style={ui.row}>
          <TextInput value={q} onChangeText={setQ} placeholder={t('products.search')} style={ui.input}
            returnKeyType="search" onSubmitEditing={() => void search()} />
          <Pressable style={ui.primary} onPress={() => setScanning(true)}><Text style={ui.primaryText}>{t('products.scan')}</Text></Pressable>
        </View>
      )}
      {hits.map((h) => (
        <Pressable key={h.productId} style={ui.card} onPress={() => {
          setHits([]); setQ('');
          onPick({ productId: h.productId, label: productLabel(h.name, language), unit: h.unit, packaging: null });
        }}>
          <Text style={{ fontWeight: '700' }}>{productLabel(h.name, language)}</Text>
          <Text style={ui.muted}>{h.sku} · {t('products.stock')}: {trimDecimal(h.quantity)} {t(`units.${h.unit}`)}</Text>
        </Pressable>
      ))}
      {message ? <Text style={ui.error}>{message}</Text> : null}
    </View>
  );
}
