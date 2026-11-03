import { useCallback, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../src/core/api-client';
import { formatTndMinor } from '../../src/core/money';
import { canDeliver, creditLimitInfo, remaining, type CreditLimitInfo, type Order } from '../../src/core/orders';
import { productLabel, trimDecimal } from '../../src/core/products';
import { getApi } from '../../src/device/session';
import { useLanguage } from '../../src/i18n/LanguageProvider';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';

/** Auftrag: Positionen, Bestätigen (Kreditlimit), Lieferungen, Rechnungen, Dokumente (T-112). */
export default function OrderScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile, canWrite } = useProfile();
  const [order, setOrder] = useState<Order | null>(null);
  const [credit, setCredit] = useState<CreditLimitInfo | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setOrder(await (await getApi()).get<Order>(`/api/v1/sales-orders/${id}`));
    } catch {
      setMessage(t('orders.loadFailed'));
    }
  }, [id, t]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  async function confirm(overrideReason?: string) {
    setBusy(true); setMessage('');
    try {
      const body = overrideReason ? { overrideReason } : {};
      setOrder(await (await getApi()).post<Order>(`/api/v1/sales-orders/${id}/confirm`, body));
      setCredit(null);
    } catch (e) {
      const info = creditLimitInfo(e);
      if (info) setCredit(info);
      else setMessage(e instanceof ApiError ? e.message : t('errors.serverUnreachable'));
    } finally {
      setBusy(false);
    }
  }

  async function invoice(deliveryId: string) {
    setBusy(true); setMessage('');
    try {
      const inv = await (await getApi()).post<{ id: string; number: string }>(`/api/v1/deliveries/${deliveryId}/invoice`, {});
      await load();
      router.push({ pathname: '/documents', params: { kind: 'invoice', id: inv.id, number: inv.number } } as never);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : t('errors.serverUnreachable'));
    } finally {
      setBusy(false);
    }
  }

  if (!order || !profile) {
    return <SafeAreaView style={ui.safe}><View style={ui.center}>{message ? <Text style={ui.error}>{message}</Text> : <ActivityIndicator />}</View></SafeAreaView>;
  }
  const money = (v: string) => `${formatTndMinor(v, language)} TND`;

  return (
    <SafeAreaView style={ui.safe}>
      <ScrollView contentContainerStyle={ui.container} keyboardShouldPersistTaps="handled">
        <LicenseBanner profile={profile} />
        <View style={ui.row}>
          <Text style={[ui.title, { flex: 1 }]}>{order.number}</Text>
          <Text style={[ui.badge, ui.warn]}>{t(`orderStatus.${order.status}`)}</Text>
        </View>
        <Pressable onPress={() => router.push({ pathname: '/customers/[id]', params: { id: order.customerId } } as never)}>
          <Text style={ui.link}>{order.customerName}</Text>
        </Pressable>

        <View style={ui.card}>
          {order.lines.map((l) => (
            <View key={l.id} style={{ gap: 2, paddingVertical: 4 }}>
              <Text style={{ fontWeight: '700' }}>{l.lineNo}. {productLabel(l.productName, language)}</Text>
              <Text style={ui.muted}>
                {trimDecimal(l.quantity)} {t(`units.${l.unit}`)} × {money(l.unitPrice)}
                {l.discountBp ? ` −${l.discountBp / 100} %` : ''} · {t('products.tax')} {l.taxRateBp / 100} %
              </Text>
              {order.status !== 'draft' ? (
                <Text>{t('orders.delivered')}: {trimDecimal(l.quantityDelivered)} · {t('orders.open')}: {remaining(l)}</Text>
              ) : null}
            </View>
          ))}
          <Text style={{ fontWeight: '700' }}>{t('orders.estimatedGross')}: {money(order.estimatedGross)}</Text>
          {order.creditOverrideReason ? <Text style={ui.muted}>{t('orders.overrideReason')}: {order.creditOverrideReason}</Text> : null}
        </View>

        {order.status === 'draft' && canWrite('sales.order') ? (
          <Pressable style={[ui.primary, busy && ui.disabled]} disabled={busy} onPress={() => void confirm()}>
            <Text style={ui.primaryText}>{t('orders.confirm')}</Text>
          </Pressable>
        ) : null}

        {credit ? (
          <View style={[ui.card, { borderColor: '#9b1c15', gap: 8 }]} accessibilityRole="alert">
            <Text style={{ fontWeight: '700', color: '#9b1c15' }}>{t('orders.creditExceeded')}</Text>
            <Text>{t('customers.openBalance')}: {money(credit.open)}</Text>
            <Text>{t('orders.thisOrder')}: {money(credit.order)}</Text>
            <Text>{t('customers.creditLimit')}: {money(credit.limit)}</Text>
            {credit.canOverride ? (
              <>
                <TextInput value={reason} onChangeText={setReason} placeholder={t('orders.overrideReason')} style={ui.input} maxLength={500} />
                <Pressable style={[ui.primary, (busy || reason.trim().length < 3) && ui.disabled]}
                  disabled={busy || reason.trim().length < 3} onPress={() => void confirm(reason.trim())}>
                  <Text style={ui.primaryText}>{t('orders.override')}</Text>
                </Pressable>
              </>
            ) : <Text style={ui.muted}>{t('orders.askOwner')}</Text>}
          </View>
        ) : null}

        {canDeliver(order) && canWrite('sales.order') ? (
          <Pressable style={ui.primary} onPress={() => router.push({ pathname: '/orders/deliver', params: { id: order.id } } as never)}>
            <Text style={ui.primaryText}>{t('orders.deliver')}</Text>
          </Pressable>
        ) : null}

        {order.deliveries.length ? <Text style={ui.section}>{t('orders.deliveries')}</Text> : null}
        {order.deliveries.map((d) => (
          <View key={d.id} style={[ui.card, { gap: 8 }]}>
            <Text style={{ fontWeight: '700' }}>{d.number} · {d.deliveredAt.slice(0, 10)}</Text>
            <View style={ui.row}>
              <Pressable style={ui.secondary} onPress={() => router.push({ pathname: '/documents', params: { kind: 'delivery', id: d.id, number: d.number } } as never)}>
                <Text style={ui.secondaryText}>{t('orders.deliveryNote')}</Text>
              </Pressable>
              {d.invoiceId ? (
                <Pressable style={ui.secondary} onPress={() => router.push({ pathname: '/documents', params: { kind: 'invoice', id: d.invoiceId as string, number: '' } } as never)}>
                  <Text style={ui.secondaryText}>{t('orders.invoice')}</Text>
                </Pressable>
              ) : canWrite('invoice.issue') ? (
                <Pressable style={[ui.primary, busy && ui.disabled]} disabled={busy} onPress={() => void invoice(d.id)}>
                  <Text style={ui.primaryText}>{t('orders.issueInvoice')}</Text>
                </Pressable>
              ) : null}
            </View>
          </View>
        ))}

        {message ? <Text style={ui.error} accessibilityRole="alert">{message}</Text> : null}
        <Pressable onPress={() => router.back()}><Text style={ui.link}>{t('back')}</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
