import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../src/core/api-client';
import type { CustomerDetail } from '../../src/core/customers';
import { formatSignedTndMinor, formatTndMinor } from '../../src/core/money';
import { sendOnce } from '../../src/core/orders';
import { PAYMENT_METHODS, paymentBody, type PaymentError, type PaymentForm } from '../../src/core/payments';
import { newOpId, secureStore } from '../../src/device/runtime';
import { getApi } from '../../src/device/session';
import { useLanguage } from '../../src/i18n/LanguageProvider';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';

/** Zahlung erfassen (T-114): Betrag, Zahlart, Scheck-/Traite-Nummer, optional Rechnung. */
export default function PaymentScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile, canWrite } = useProfile();
  const [detail, setDetail] = useState<CustomerDetail | null>(null);
  const [form, setForm] = useState<PaymentForm>({ amount: '', method: 'cash', reference: '', receivedAt: '', invoiceId: null });
  const [errors, setErrors] = useState<Partial<Record<keyof PaymentForm, PaymentError>>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try { setDetail(await (await getApi()).get<CustomerDetail>(`/api/v1/customers/${id}`)); } catch { setMessage(t('customers.loadFailed')); }
    })();
  }, [id, t]);

  const set = <K extends keyof PaymentForm>(k: K, v: PaymentForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    const today = new Date().toISOString().slice(0, 10);
    const r = paymentBody(form, today);
    if (!r.ok) { setErrors(r.errors); return; }
    setErrors({}); setMessage(''); setBusy(true);
    try {
      const api = await getApi();
      await sendOnce(secureStore, `payment:${id}`, r.body, newOpId,
        (clientOpId) => api.post(`/api/v1/customers/${id}/payments`, { ...r.body, clientOpId }));
      router.back();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : t('orders.sendFailedRetry'));
    } finally {
      setBusy(false);
    }
  }

  if (!profile || !detail) {
    return <SafeAreaView style={ui.safe}><View style={ui.center}>{message ? <Text style={ui.error}>{message}</Text> : <ActivityIndicator />}</View></SafeAreaView>;
  }
  const writable = canWrite('payment.record');
  const invoices = detail.recentInvoices.filter((i) => !i.isCreditNote);
  const err = (k: keyof PaymentForm) => (errors[k] ? <Text style={ui.error}>{t(`payments.errors.${errors[k]}`)}</Text> : null);

  return (
    <SafeAreaView style={ui.safe}>
      <ScrollView contentContainerStyle={ui.container} keyboardShouldPersistTaps="handled">
        <Text style={ui.title}>{t('payments.record')}</Text>
        <LicenseBanner profile={profile} />
        <View style={ui.card}>
          <Text style={{ fontWeight: '700' }}>{detail.customer.name}</Text>
          <Text>{t('customers.openBalance')}: {formatSignedTndMinor(detail.customer.openBalance, language)} TND</Text>
        </View>

        <Text>{t('payments.amount')} (TND) *</Text>
        <TextInput value={form.amount} onChangeText={(v) => set('amount', v)} keyboardType="decimal-pad" style={ui.input} editable={writable} />
        {err('amount')}

        <Text>{t('payments.method')}</Text>
        <View style={ui.row}>
          {PAYMENT_METHODS.map((m) => (
            <Pressable key={m} style={[ui.chip, form.method === m && ui.chipActive]} onPress={() => writable && set('method', m)}>
              <Text style={form.method === m ? ui.chipActiveText : undefined}>{t(`payments.methods.${m}`)}</Text>
            </Pressable>
          ))}
        </View>

        <Text>{t('payments.reference')}{form.method === 'cheque' || form.method === 'traite' ? ' *' : ''}</Text>
        <TextInput value={form.reference} onChangeText={(v) => set('reference', v)} style={ui.input} editable={writable} maxLength={100} />
        {err('reference')}

        <Text>{t('payments.receivedAt')}</Text>
        <TextInput value={form.receivedAt} onChangeText={(v) => set('receivedAt', v)} placeholder={t('payments.todayIfEmpty')}
          style={ui.input} keyboardType="numbers-and-punctuation" editable={writable} />
        {err('receivedAt')}

        {invoices.length ? (
          <>
            <Text>{t('payments.forInvoice')}</Text>
            <View style={ui.row}>
              {invoices.map((i) => (
                <Pressable key={i.id} style={[ui.chip, form.invoiceId === i.id && ui.chipActive]}
                  onPress={() => writable && set('invoiceId', form.invoiceId === i.id ? null : i.id)}>
                  <Text style={form.invoiceId === i.id ? ui.chipActiveText : undefined}>{i.number} · {formatTndMinor(i.grossTotal, language)}</Text>
                </Pressable>
              ))}
            </View>
          </>
        ) : null}

        {message ? <Text style={ui.error} accessibilityRole="alert">{message}</Text> : null}
        <Pressable style={[ui.primary, (!writable || busy) && ui.disabled]} disabled={!writable || busy} onPress={() => void save()}>
          {busy ? <ActivityIndicator color="white" /> : <Text style={ui.primaryText}>{t('payments.save')}</Text>}
        </Pressable>
        <Pressable onPress={() => router.back()}><Text style={ui.link}>{t('back')}</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
