import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { trimDecimal } from '../../src/core/products';
import type { StockAlerts } from '../../src/core/warehouse';
import { getApi } from '../../src/device/session';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';
import { BackLink, CenteredMessage, LoadingScreen, PrimaryButton, ScreenScroll } from '../../src/ui/components';

export default function WarehouseScreen() {
  const { t } = useTranslation();
  const { profile, storeId, can, canWrite } = useProfile();
  const [alerts, setAlerts] = useState<StockAlerts | null>(null);
  const [error, setError] = useState('');

  useFocusEffect(useCallback(() => {
    if (!storeId || !profile?.permissions.includes('report.stock')) return;
    void (async () => {
      try {
        setAlerts(await (await getApi()).get<StockAlerts>(`/api/v1/stores/${storeId}/stock-alerts`));
      } catch {
        setError(t('warehouse.alertsFailed'));
      }
    })();
  }, [storeId, profile, t]));

  if (!profile) return <LoadingScreen />;
  if (!storeId) return <CenteredMessage text={t('home.noStore')} />;

  const action = (perm: string, route: string, label: string) => (canWrite(perm) ? (
    <PrimaryButton key={route} label={label} onPress={() => router.push(route as never)} />
  ) : null);

  return (
    <ScreenScroll>
      <Text style={ui.title}>{t('tiles.warehouse')}</Text>
      <LicenseBanner profile={profile} />
      {action('stock.receive', '/warehouse/receive', t('warehouse.receive'))}
      {action('stock.adjust', '/warehouse/count', t('warehouse.count'))}
      {action('stock.adjust', '/warehouse/loss', t('warehouse.loss'))}

      {can('report.stock') ? (
        <>
          <Text style={ui.section}>{t('warehouse.expiringSoon')}</Text>
          {error ? <Text style={ui.error}>{error}</Text> : null}
          {!alerts && !error ? <ActivityIndicator /> : null}
          {alerts?.expiringSoon.length === 0 ? <Text style={ui.muted}>{t('warehouse.none')}</Text> : null}
          {alerts?.expiringSoon.map((a) => (
            <Pressable key={`${a.productId}-${a.lotNumber}-${a.expiryDate}`} style={ui.card}
              onPress={() => router.push({ pathname: '/products/[id]', params: { id: a.productId } } as never)}>
              <View style={ui.row}>
                <Text style={{ fontWeight: '700', flex: 1 }}>{a.name}</Text>
                <Text style={[ui.badge, a.daysLeft < 0 ? ui.danger : ui.warn]}>
                  {a.daysLeft < 0 ? t('products.expiry.expired') : t('warehouse.daysLeft', { count: a.daysLeft })}
                </Text>
              </View>
              <Text style={ui.muted}>{a.sku} · {a.lotNumber ?? '—'} · {a.expiryDate} · {trimDecimal(a.quantity)}</Text>
            </Pressable>
          ))}
          <Text style={ui.section}>{t('warehouse.lowStock')}</Text>
          {alerts?.lowStock.length === 0 ? <Text style={ui.muted}>{t('warehouse.none')}</Text> : null}
          {alerts?.lowStock.map((a) => (
            <Pressable key={a.productId} style={ui.card}
              onPress={() => router.push({ pathname: '/products/[id]', params: { id: a.productId } } as never)}>
              <Text style={{ fontWeight: '700' }}>{a.name}</Text>
              <Text style={ui.muted}>{a.sku} · {t('products.stock')}: {trimDecimal(a.quantity)} / {t('products.minStock')}: {trimDecimal(a.minStock)}</Text>
            </Pressable>
          ))}
        </>
      ) : null}
      <BackLink />
    </ScreenScroll>
  );
}
