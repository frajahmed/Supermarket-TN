import { useState } from 'react';
import { router } from 'expo-router';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatTndMinor } from '../../src/core/money';
import { productLabel } from '../../src/core/products';
import { useLanguage } from '../../src/i18n/LanguageProvider';
import { BarcodeScanner } from '../../src/ui/BarcodeScanner';
import { CenteredMessage, LoadingScreen, Messages, ScreenScroll, SecondaryButton } from '../../src/ui/components';
import { CartLineRow } from '../../src/ui/pos/CartLineRow';
import { PaymentPanel } from '../../src/ui/pos/PaymentPanel';
import { SaleDone } from '../../src/ui/pos/SaleDone';
import { usePosSale, type StockHit } from '../../src/ui/pos/usePosSale';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';

export default function PosScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { profile, storeId, canWrite } = useProfile();
  const sale = usePosSale(storeId);
  const [scanning, setScanning] = useState(true);
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<StockHit[]>([]);

  if (!profile) return <LoadingScreen />;
  if (!storeId) return <CenteredMessage text={t('home.noStore')} />;
  if (sale.done) return <SaleDone sale={sale.done} onNext={sale.reset} />;

  return (
    <ScreenScroll>
      <View style={ui.row}>
      <Text style={[ui.title, { flex: 1 }]}>{t('tiles.pos')}</Text>
      <Pressable onPress={() => router.push('/pos/receipts' as never)}><Text style={ui.link}>{t('pos.receipts')}</Text></Pressable>
      </View>
      <LicenseBanner profile={profile} />
      {scanning
      ? <BarcodeScanner onCode={(c) => void sale.scan(c)} onClose={() => setScanning(false)} hint={t('pos.scanHint')} />
      : <SecondaryButton label={t('products.scan')} onPress={() => setScanning(true)} />}
      <TextInput value={query} onChangeText={setQuery} placeholder={t('products.search')} style={ui.input} returnKeyType="search"
      onSubmitEditing={() => void sale.search(query).then(setHits)} />
      {hits.map((h) => (
      <Pressable key={h.productId} style={ui.card} onPress={() => { sale.add(h); setHits([]); setQuery(''); }}>
        <Text style={{ fontWeight: '700' }}>{productLabel(h.name, language)}</Text>
        <Text style={ui.muted}>{h.sku} · {h.salePrice ? `${formatTndMinor(h.salePrice, language)} TND` : t('pos.noPriceShort')}</Text>
      </Pressable>
      ))}
      {sale.cart.map((l) => (
      <CartLineRow key={l.productId} line={l} limitBp={sale.config.cashierMaxDiscountBp}
        onChange={(patch) => sale.updateLine(l.productId, patch)} onRemove={() => sale.removeLine(l.productId)} onError={sale.setMessage} />
      ))}
      {sale.cart.length
      ? <PaymentPanel sale={sale} canPay={canWrite('sale.create')} />
      : <><Text style={ui.muted}>{t('pos.emptyCart')}</Text><Messages error={sale.message} /></>}
    </ScreenScroll>
  );
}
