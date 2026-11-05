import { useCallback, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatTndMinor } from '../../src/core/money';
import { expiryState, productLabel, stockState, trimDecimal, type ProductDetail } from '../../src/core/products';
import { getApi } from '../../src/device/session';
import { useLanguage } from '../../src/i18n/LanguageProvider';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';
import { BackLink, LoadingScreen, PrimaryButton, ScreenScroll } from '../../src/ui/components';
import { PackagingEditor } from '../../src/ui/products/PackagingEditor';

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

  if (error) return <LoadingScreen error={error} />;
  if (!data) return <LoadingScreen />;
  const p = data.product;
  const unit = t(`units.${p.unit}`);

  return (
    <ScreenScroll>
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

      <PackagingEditor detail={data} writable={canWrite('product.write')} onChanged={() => void load()} />

      {canWrite('product.write') ? (
        <PrimaryButton label={t('products.edit')} onPress={() => router.push({ pathname: '/products/edit', params: { id: p.id } } as never)} />
      ) : null}
      <BackLink />
    </ScreenScroll>
  );
}
