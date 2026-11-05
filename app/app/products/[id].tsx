import { useCallback, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatTndMinor } from '../../src/core/money';
import { expiryState, productLabel, stockState, trimDecimal, type ProductDetail } from '../../src/core/products';
import { getApi } from '../../src/device/session';
import { useLanguage } from '../../src/i18n/LanguageProvider';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';

export default function ProductDetailScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile, storeId, canWrite } = useProfile();
  const [data, setData] = useState<ProductDetail | null>(null);
  const [error, setError] = useState('');
  const today = new Date().toISOString().slice(0, 10);

  const load = useCallback(async () => {
    if (!profile) return;
    setError('');
    try {
      const query = storeId ? `?storeId=${storeId}` : '';
      setData(await (await getApi()).get<ProductDetail>(`/api/v1/products/${id}${query}`));
    } catch {
      setError(t('products.loadFailed'));
    }
  }, [id, profile, storeId, t]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  if (error) return <SafeAreaView style={ui.safe}><View style={ui.center}><Text style={ui.error}>{error}</Text></View></SafeAreaView>;
  if (!data) return <SafeAreaView style={ui.safe}><View style={ui.center}><ActivityIndicator /></View></SafeAreaView>;
  const p = data.product;
  const unit = t(`units.${p.unit}`);

  return (
    <SafeAreaView style={ui.safe}>
      <ScrollView contentContainerStyle={ui.container}>
        <LicenseBanner profile={profile} />
        <Text style={ui.title}>{productLabel(p.name, language)}</Text>
        <Text style={ui.muted}>{p.sku}{p.isActive ? '' : ` · ${t('products.inactive')}`}</Text>

        <View style={ui.card}>
          {p.salePrice ? <Text>{t('products.salePrice')}: {formatTndMinor(p.salePrice, language)} TND</Text> : null}
          {p.purchasePrice ? <Text>{t('products.purchasePrice')}: {formatTndMinor(p.purchasePrice, language)} TND</Text> : null}
          <Text>{t('products.tax')}: {p.taxRateBp / 100} %</Text>
        </View>

        {data.stock ? (
          <View style={ui.card}>
            <View style={ui.row}>
              <Text style={{ fontWeight: '700' }}>{t('products.stock')}: {trimDecimal(data.stock.quantity)} {unit}</Text>
              {stockState(data.stock.quantity, data.stock.minStock) !== 'ok'
                ? <Text style={[ui.badge, ui.warn]}>{t(`products.state.${stockState(data.stock.quantity, data.stock.minStock)}`)}</Text> : null}
            </View>
            <Text style={ui.muted}>{t('products.minStock')}: {trimDecimal(data.stock.minStock)} {unit}
              {data.stock.shelfLocation ? ` · ${t('products.location')}: ${data.stock.shelfLocation}` : ''}</Text>
            {data.stock.lots.length ? <Text style={ui.section}>{t('products.lots')}</Text> : null}
            {data.stock.lots.map((l) => {
              const e = expiryState(l.expiryDate, today);
              return (
                <View key={l.id} style={ui.row}>
                  <Text>{l.lotNumber ?? '—'} · {trimDecimal(l.quantity)} {unit}</Text>
                  {l.expiryDate ? <Text style={[ui.badge, e === 'expired' ? ui.danger : e === 'soon' ? ui.warn : {}]}>{l.expiryDate}</Text> : null}
                </View>
              );
            })}
          </View>
        ) : null}

        <Text style={ui.section}>{t('products.packagings')}</Text>
        <View style={ui.card}>
          <Text>1 {unit}</Text>
          {data.packagings.map((pk) => (
            <Text key={pk.id}>{productLabel(pk.name, language) || pk.code} = {trimDecimal(pk.factor)} {unit}{pk.gtin ? ` · ${pk.gtin}` : ''}</Text>
          ))}
        </View>

        <Text style={ui.section}>{t('products.barcodes')}</Text>
        <View style={ui.card}>
          {data.barcodes.length === 0 ? <Text style={ui.muted}>—</Text> : data.barcodes.map((b) => (
            <Text key={b.code}>{b.code} · {b.symbology}{b.packQty !== '1.000' ? ` × ${trimDecimal(b.packQty)}` : ''}</Text>
          ))}
        </View>

        {canWrite('product.write') ? (
          <Pressable style={ui.primary} onPress={() => router.push({ pathname: '/products/edit', params: { id: p.id } } as never)}>
            <Text style={ui.primaryText}>{t('products.edit')}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => router.back()}><Text style={ui.link}>{t('back')}</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
