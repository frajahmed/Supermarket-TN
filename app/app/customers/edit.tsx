import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../src/core/api-client';
import {
  customerBodyFromForm, EMPTY_CUSTOMER_FORM, fieldErrorsFromServer, formFromCustomer,
  type Customer, type CustomerDetail, type CustomerForm, type CustomerFormError, type CustomerLocale, type CustomerType,
} from '../../src/core/customers';
import { changedFields } from '../../src/core/products';
import { getApi } from '../../src/device/session';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';

const TYPES: CustomerType[] = ['business', 'individual'];
const LOCALES: CustomerLocale[] = ['fr-TN', 'ar-TN', 'en'];

/** Kunde anlegen oder ändern (T-111). Nummer vergibt der Server (CL-JJJJ-NNNNNN). */
export default function CustomerEditScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { profile, canWrite } = useProfile();
  const [form, setForm] = useState<CustomerForm>(EMPTY_CUSTOMER_FORM);
  const [initial, setInitial] = useState<CustomerForm | null>(null);
  const [loading, setLoading] = useState(Boolean(id));
  const [errors, setErrors] = useState<Partial<Record<keyof CustomerForm, CustomerFormError>>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const writable = canWrite('customer.manage');
  const opts = { canEditCredit: writable };

  useEffect(() => {
    if (!id) return;
    void (async () => {
      try {
        const d = await (await getApi()).get<CustomerDetail>(`/api/v1/customers/${id}`);
        const f = formFromCustomer(d.customer);
        setForm(f); setInitial(f);
      } catch {
        setMessage(t('customers.loadFailed'));
      } finally {
        setLoading(false);
      }
    })();
  }, [id, t]);

  const set = <K extends keyof CustomerForm>(k: K, v: CustomerForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function save() {
    const result = customerBodyFromForm(form, opts);
    if (!result.ok) { setErrors(result.errors); return; }
    setErrors({}); setMessage(''); setBusy(true);
    try {
      const api = await getApi();
      if (id && initial) {
        const before = customerBodyFromForm(initial, opts);
        const patch = before.ok ? changedFields(before.body, result.body) : result.body;
        if (Object.keys(patch).length) await api.patch(`/api/v1/customers/${id}`, patch);
        router.back();
      } else {
        const created = await api.post<Customer>('/api/v1/customers', result.body);
        router.replace({ pathname: '/customers/[id]', params: { id: created.id } } as never);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 400) {
        const fields = fieldErrorsFromServer(e.body);
        setErrors(fields);
        if (!Object.keys(fields).length) setMessage(e.message);
      } else if (e instanceof ApiError && e.status === 409) setMessage(t('customers.errors.numberTaken'));
      else if (e instanceof ApiError && e.status === 403) setMessage(t('products.forbidden'));
      else setMessage(t('products.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (loading || !profile) return <SafeAreaView style={ui.safe}><View style={ui.center}><ActivityIndicator /></View></SafeAreaView>;

  const field = (key: keyof CustomerForm, label: string, extra: object = {}) => (
    <View style={{ gap: 4 }}>
      <Text>{label}</Text>
      <TextInput value={String(form[key])} onChangeText={(v) => set(key, v as never)} style={ui.input} editable={writable} {...extra} />
      {errors[key] ? <Text style={ui.error}>{t(`customers.errors.${errors[key]}`)}</Text> : null}
    </View>
  );
  const chips = <T extends string>(values: readonly T[], current: T, onPick: (v: T) => void, label: (v: T) => string) => (
    <View style={ui.row}>
      {values.map((v) => (
        <Pressable key={v} style={[ui.chip, current === v && ui.chipActive]} onPress={() => writable && onPick(v)}
          accessibilityState={{ selected: current === v }}>
          <Text style={current === v ? ui.chipActiveText : undefined}>{label(v)}</Text>
        </Pressable>
      ))}
    </View>
  );

  return (
    <SafeAreaView style={ui.safe}>
      <ScrollView contentContainerStyle={ui.container} keyboardShouldPersistTaps="handled">
        <Text style={ui.title}>{id ? t('customers.edit') : t('customers.create')}</Text>
        <LicenseBanner profile={profile} />
        {chips(TYPES, form.type, (v) => set('type', v), (v) => t(`customers.type.${v}`))}
        {field('name', t('customers.name'))}
        {field('taxId', form.type === 'business' ? `${t('customers.taxId')} *` : t('customers.taxId'),
          { autoCapitalize: 'characters', autoCorrect: false, placeholder: '1234567A/M/A/000' })}
        {field('legalName', t('customers.legalName'))}
        {field('phone', t('customers.phone'), { keyboardType: 'phone-pad' })}
        {field('email', t('email'), { keyboardType: 'email-address', autoCapitalize: 'none' })}
        <Text style={ui.section}>{t('customers.address')}</Text>
        {field('street', t('customers.street'))}
        <View style={ui.row}>
          <View style={{ flex: 1 }}>{field('postalCode', t('customers.postalCode'), { keyboardType: 'number-pad' })}</View>
          <View style={{ flex: 2 }}>{field('city', t('customers.city'))}</View>
        </View>
        {field('governorate', t('customers.governorate'))}

        <Text style={ui.section}>{t('customers.terms')}</Text>
        {field('creditLimit', `${t('customers.creditLimit')} (TND) – ${t('customers.emptyNoLimit')}`, { keyboardType: 'decimal-pad' })}
        {field('paymentTermsDays', t('customers.paymentTerms'), { keyboardType: 'number-pad' })}
        <View style={ui.row}>
          <Switch value={form.vatExempt} onValueChange={(v) => set('vatExempt', v)} disabled={!writable} />
          <Text>{t('customers.vatExempt')}</Text>
        </View>
        <Text>{t('customers.documentLanguage')}</Text>
        {chips(LOCALES, form.preferredLocale, (v) => set('preferredLocale', v), (v) => t(`customers.locale.${v}`))}

        {message ? <Text style={ui.error} accessibilityRole="alert">{message}</Text> : null}
        <Pressable style={[ui.primary, (!writable || busy) && ui.disabled]} disabled={!writable || busy} onPress={() => void save()}>
          {busy ? <ActivityIndicator color="white" /> : <Text style={ui.primaryText}>{t('products.save')}</Text>}
        </Pressable>
        <Pressable onPress={() => router.back()}><Text style={ui.link}>{t('back')}</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
