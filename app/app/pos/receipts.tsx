import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../src/core/api-client';
import { formatSignedTndMinor } from '../../src/core/money';
import { sendOnce } from '../../src/core/orders';
import { newOpId, secureStore } from '../../src/device/runtime';
import { getApi } from '../../src/device/session';
import { useLanguage } from '../../src/i18n/LanguageProvider';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';
import { BackLink, LoadingScreen, Messages, ScreenScroll, SecondaryButton } from '../../src/ui/components';

interface Receipt { id: string; receiptNumber: string; deviceName: string; grossTotal: string; completedAt: string;
  voidsSaleId: string | null; voided: boolean; cashier: string }

export default function ReceiptsScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { profile, storeId, canWrite } = useProfile();
  const [data, setData] = useState<{ items: Receipt[]; total: string } | null>(null);
  const [voiding, setVoiding] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    if (!storeId) return;
    try { setData(await (await getApi()).get(`/api/v1/pos/sales?storeId=${storeId}`)); } catch { setMessage(t('pos.loadFailed')); }
  }, [storeId, t]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  async function voidSale(id: string) {
    setMessage('');
    try {
      const api = await getApi();
      const r = await sendOnce(secureStore, `void:${id}`, { reason: reason.trim() }, newOpId,
        (clientOpId) => api.post<{ id: string; receiptNumber: string }>(`/api/v1/pos/sales/${id}/void`, { reason: reason.trim(), clientOpId }));
      setVoiding(null); setReason('');
      await load();
      router.push({ pathname: '/documents', params: { kind: 'receipt', id: r.id, number: r.receiptNumber } } as never);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : t('orders.sendFailedRetry'));
    }
  }

  if (!profile || !data) return <LoadingScreen error={message} />;

  return (
    <ScreenScroll>
      <Text style={ui.title}>{t('pos.receipts')}</Text>
      <LicenseBanner profile={profile} />
      <Text style={{ fontWeight: '700' }}>{t('pos.dayTotal')}: {formatSignedTndMinor(data.total, language)} TND · {data.items.length}</Text>
      {data.items.map((r) => (
        <View key={r.id} style={[ui.card, { gap: 6 }]}>
          <View style={ui.row}>
            <Text style={{ fontWeight: '700', flex: 1 }}>N° {r.receiptNumber} · {r.deviceName}</Text>
            {r.voidsSaleId ? <Text style={[ui.badge, ui.danger]}>{t('pos.voidReceipt')}</Text> : null}
            {r.voided ? <Text style={[ui.badge, ui.warn]}>{t('payments.reversed')}</Text> : null}
          </View>
          <Text style={ui.muted}>{r.completedAt.slice(11, 16)} · {r.cashier} · {formatSignedTndMinor(r.grossTotal, language)} TND</Text>
          <View style={ui.row}>
            <SecondaryButton label={t('pos.reprint')} onPress={() => router.push({ pathname: '/documents', params: { kind: 'receipt', id: r.id, number: r.receiptNumber } } as never)} />
            {!r.voidsSaleId && !r.voided && canWrite('sale.void') && voiding !== r.id
              ? <Pressable onPress={() => { setVoiding(r.id); setReason(''); }}><Text style={ui.error}>{t('pos.void')}</Text></Pressable> : null}
          </View>
          {voiding === r.id ? (
            <View style={ui.row}>
              <TextInput value={reason} onChangeText={setReason} placeholder={t('pos.voidReason')} style={ui.input} maxLength={500} />
              <SecondaryButton label={t('pos.confirmVoid')} onPress={() => void voidSale(r.id)} disabled={reason.trim().length < 3} />
            </View>
          ) : null}
        </View>
      ))}
      <Messages error={message} />
      <BackLink />
    </ScreenScroll>
  );
}
