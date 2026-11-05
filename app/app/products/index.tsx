import { useCallback, useRef, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, SafeAreaView, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatTndMinor } from '../../src/core/money';
import { expiryState, productLabel, stockState, trimDecimal, type LocalizedName } from '../../src/core/products';
import { getApi } from '../../src/device/session';
import { useLanguage } from '../../src/i18n/LanguageProvider';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';
import { CenteredMessage, LoadingScreen, PrimaryButton, SecondaryButton } from '../../src/ui/components';

interface StockItem {
  productId: string; sku: string; name: LocalizedName; unit: string; salePrice: string | null;
  quantity: string; minStock: string; belowMin: boolean; nextExpiry: string | null;
}

export default function ProductsScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { profile, storeId, canWrite } = useProfile();
  const [q, setQ] = useState('');
  const query = useRef('');
  query.current = q;
  const [lowOnly, setLowOnly] = useState(false);
  const [items, setItems] = useState<StockItem[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const today = new Date().toISOString().slice(0, 10);

  const load = useCallback(async (reset: boolean, after: string | null = null) => {
    if (!storeId) return;
    setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (query.current.trim()) params.set('q', query.current.trim());
      if (lowOnly) params.set('low', 'true');
      if (!reset && after) params.set('cursor', after);
      const page = await (await getApi()).get<{ items: StockItem[]; nextCursor: string | null }>(
        `/api/v1/stores/${storeId}/stock?${params.toString()}`);
      setItems((prev) => (reset ? page.items : [...prev, ...page.items]));
      setCursor(page.nextCursor);
    } catch {
      setError(t('products.loadFailed'));
    } finally {
      setBusy(false);
    }
  }, [storeId, lowOnly, t]);

  // Beim Zurückkehren (z. B. nach dem Anlegen) neu laden
  useFocusEffect(useCallback(() => { void load(true); }, [load]));

  if (!profile) return <LoadingScreen />;
  if (!storeId) return <CenteredMessage text={t('home.noStore')} />;

  return (
    <SafeAreaView style={ui.safe}>
      <FlatList
        contentContainerStyle={ui.container}
        data={items}
        keyExtractor={(i) => i.productId}
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            <Text style={ui.title}>{t('tiles.products')}</Text>
            <LicenseBanner profile={profile} />
            <View style={ui.row}>
              <TextInput value={q} onChangeText={setQ} placeholder={t('products.search')} style={ui.input}
                returnKeyType="search" onSubmitEditing={() => void load(true)} autoCorrect={false} />
              <PrimaryButton label={t('products.scan')} onPress={() => router.push('/products/scan' as never)} />
            </View>
            <View style={ui.row}>
              <Pressable style={[ui.chip, lowOnly && ui.chipActive]} onPress={() => setLowOnly((v) => !v)} accessibilityState={{ selected: lowOnly }}>
                <Text style={lowOnly ? ui.chipActiveText : undefined}>{t('products.lowOnly')}</Text>
              </Pressable>
              {canWrite('product.write') ? (
                <SecondaryButton label={t('products.create')} onPress={() => router.push('/products/edit' as never)} />
                <SecondaryButton label={t('import.title')} onPress={() => router.push('/products/import' as never)} />
              ) : null}
            </View>
            {error ? <Text style={ui.error} accessibilityRole="alert">{error}</Text> : null}
          </View>
        }
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        renderItem={({ item }) => {
          const state = stockState(item.quantity, item.minStock);
          const expiry = expiryState(item.nextExpiry, today);
          return (
            <Pressable style={ui.card} accessibilityRole="button"
              onPress={() => router.push({ pathname: '/products/[id]', params: { id: item.productId } } as never)}>
              <Text style={{ fontWeight: '700' }}>{productLabel(item.name, language)}</Text>
              <Text style={ui.muted}>{item.sku}{item.salePrice ? ` · ${formatTndMinor(item.salePrice, language)} TND` : ''}</Text>
              <View style={ui.row}>
                <Text>{t('products.stock')}: {trimDecimal(item.quantity)} {t(`units.${item.unit}`)}</Text>
                {state !== 'ok' ? <Text style={[ui.badge, state === 'negative' ? ui.danger : ui.warn]}>{t(`products.state.${state}`)}</Text> : null}
                {expiry && expiry !== 'ok' ? (
                  <Text style={[ui.badge, expiry === 'expired' ? ui.danger : ui.warn]}>{t(`products.expiry.${expiry}`)} {item.nextExpiry}</Text>
                ) : null}
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={busy ? null : <Text style={ui.muted}>{t('products.empty')}</Text>}
        ListFooterComponent={busy ? <ActivityIndicator /> : cursor ? (
          <SecondaryButton label={t('products.more')} onPress={() => void load(false, cursor)} />
        ) : null}
      />
    </SafeAreaView>
  );
}
