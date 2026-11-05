import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, SafeAreaView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatTndMinor } from '../../src/core/money';
import { getApi } from '../../src/device/session';
import { useLanguage } from '../../src/i18n/LanguageProvider';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';
import { LoadingScreen, PrimaryButton, SecondaryButton } from '../../src/ui/components';

type Tab = 'orders' | 'invoices';
const STATUSES = ['all', 'draft', 'confirmed', 'delivered', 'invoiced'] as const;
interface Row {
  id: string; number: string; status: string; customerName: string; createdAt: string;
  estimatedGross?: string; grossTotal?: string; issueDate?: string | null; dueDate?: string | null; isCreditNote?: boolean;
}

export default function OrdersScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { profile, storeId, canWrite } = useProfile();
  const [tab, setTab] = useState<Tab>('orders');
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('all');
  const [items, setItems] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (after: string | null = null) => {
    if (!profile) return;
    setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ limit: '30' });
      if (after) params.set('cursor', after);
      if (tab === 'orders') {
        if (status !== 'all') params.set('status', status);
        if (storeId) params.set('storeId', storeId);
      }
      const path = tab === 'orders' ? '/api/v1/sales-orders' : '/api/v1/invoices';
      const page = await (await getApi()).get<{ items: Row[]; nextCursor: string | null }>(`${path}?${params.toString()}`);
      setItems((prev) => (after ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch {
      setError(t('orders.loadFailed'));
    } finally {
      setBusy(false);
    }
  }, [profile, tab, status, storeId, t]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  if (!profile) return <LoadingScreen />;

  const chip = (active: boolean, label: string, onPress: () => void) => (
    <Pressable key={label} style={[ui.chip, active && ui.chipActive]} onPress={onPress} accessibilityState={{ selected: active }}>
      <Text style={active ? ui.chipActiveText : undefined}>{label}</Text>
    </Pressable>
  );

  return (
    <SafeAreaView style={ui.safe}>
      <FlatList
        contentContainerStyle={ui.container}
        data={items}
        keyExtractor={(r) => r.id}
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            <Text style={ui.title}>{t('tiles.orders')}</Text>
            <LicenseBanner profile={profile} />
            <View style={ui.row}>
              {chip(tab === 'orders', t('orders.orders'), () => setTab('orders'))}
              {chip(tab === 'invoices', t('orders.invoices'), () => setTab('invoices'))}
              {canWrite('sales.order') ? (
                <PrimaryButton label={t('orders.new')} onPress={() => router.push('/orders/new' as never)} />
              ) : null}
            </View>
            {tab === 'orders' ? (
              <View style={ui.row}>
                {STATUSES.map((s) => chip(status === s, s === 'all' ? t('orders.all') : t(`orderStatus.${s}`), () => setStatus(s)))}
              </View>
            ) : null}
            {error ? <Text style={ui.error} accessibilityRole="alert">{error}</Text> : null}
          </View>
        }
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        renderItem={({ item }) => (
          <Pressable style={ui.card} accessibilityRole="button" onPress={() => (tab === 'orders'
            ? router.push({ pathname: '/orders/[id]', params: { id: item.id } } as never)
            : router.push({ pathname: '/documents', params: { kind: 'invoice', id: item.id, number: item.number } } as never))}>
            <View style={ui.row}>
              <Text style={{ fontWeight: '700', flex: 1 }}>{item.isCreditNote ? `${t('customers.creditNote')} ` : ''}{item.number}</Text>
              <Text style={[ui.badge, ui.warn]}>{tab === 'orders' ? t(`orderStatus.${item.status}`) : t(`invoiceStatus.${item.status}`)}</Text>
            </View>
            <Text>{item.customerName}</Text>
            <Text style={ui.muted}>
              {tab === 'orders' ? item.createdAt.slice(0, 10) : `${item.issueDate ?? ''}${item.dueDate ? ` → ${item.dueDate}` : ''}`}
              {' · '}{formatTndMinor((tab === 'orders' ? item.estimatedGross : item.grossTotal) ?? '0', language)} TND
            </Text>
          </Pressable>
        )}
        ListEmptyComponent={busy ? null : <Text style={ui.muted}>{t('orders.empty')}</Text>}
        ListFooterComponent={busy ? <ActivityIndicator /> : cursor ? (
          <SecondaryButton label={t('products.more')} onPress={() => void load(cursor)} />
        ) : null}
      />
    </SafeAreaView>
  );
}
