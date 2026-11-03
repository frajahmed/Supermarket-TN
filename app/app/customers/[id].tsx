import { useCallback, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { availableCredit, creditState, type CustomerDetail } from '../../src/core/customers';
import { formatSignedTndMinor as formatSigned, formatTndMinor } from '../../src/core/money';
import { productLabel } from '../../src/core/products';
import { getApi } from '../../src/device/session';
import { useLanguage } from '../../src/i18n/LanguageProvider';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';

/** Kundendetail: Saldo, Limit, Zahlungsziel, letzte Aufträge und Rechnungen (T-111). */
export default function CustomerDetailScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile, canWrite } = useProfile();
  const [data, setData] = useState<CustomerDetail | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      setData(await (await getApi()).get<CustomerDetail>(`/api/v1/customers/${id}`));
    } catch {
      setError(t('customers.loadFailed'));
    }
  }, [id, t]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  if (error) return <SafeAreaView style={ui.safe}><View style={ui.center}><Text style={ui.error}>{error}</Text></View></SafeAreaView>;
  if (!data) return <SafeAreaView style={ui.safe}><View style={ui.center}><ActivityIndicator /></View></SafeAreaView>;
  const c = data.customer;
  const credit = creditState(c.openBalance, c.creditLimit);
  const available = availableCredit(c.openBalance, c.creditLimit);
  const address = [c.billingAddress.street, c.billingAddress.postalCode, c.billingAddress.city, c.billingAddress.governorate]
    .filter(Boolean).join(', ');

  return (
    <SafeAreaView style={ui.safe}>
      <ScrollView contentContainerStyle={ui.container}>
        <LicenseBanner profile={profile} />
        <Text style={ui.title}>{c.name}</Text>
        <Text style={ui.muted}>{c.number} · {t(`customers.type.${c.type}`)}{data.groupName ? ` · ${productLabel(data.groupName, language)}` : ''}</Text>

        <View style={[ui.card, credit === 'over' ? { borderColor: '#9b1c15' } : null]}>
          <Text style={{ fontWeight: '700' }}>{t('customers.openBalance')}: {formatSigned(c.openBalance, language)} TND</Text>
          <Text>{t('customers.creditLimit')}: {c.creditLimit === null ? t('customers.noLimit') : `${formatTndMinor(c.creditLimit, language)} TND`}</Text>
          {available !== null ? <Text>{t('customers.available')}: {formatTndMinor(available, language)} TND</Text> : null}
          {credit === 'over' || credit === 'near'
            ? <Text style={[ui.badge, credit === 'over' ? ui.danger : ui.warn, { alignSelf: 'flex-start' }]}>{t(`customers.credit.${credit}`)}</Text> : null}
          <Text>{t('customers.paymentTerms')}: {t('customers.days', { count: c.paymentTermsDays })}</Text>
        </View>

        <View style={ui.card}>
          {c.taxId ? <Text>{t('customers.taxId')}: {c.taxId}{c.vatExempt ? ` · ${t('customers.vatExempt')}` : ''}</Text> : null}
          {c.legalName ? <Text>{c.legalName}</Text> : null}
          {address ? <Text>{address}</Text> : null}
          {c.phone ? <Text>{c.phone}</Text> : null}
          {c.email ? <Text>{c.email}</Text> : null}
          <Text style={ui.muted}>{t('customers.documentLanguage')}: {t(`customers.locale.${c.preferredLocale}`)}</Text>
        </View>

        <Text style={ui.section}>{t('customers.recentOrders')}</Text>
        <View style={ui.card}>
          {data.recentOrders.length === 0 ? <Text style={ui.muted}>—</Text> : data.recentOrders.map((o) => (
            <Text key={o.id}>{o.number} · {t(`orderStatus.${o.status}`)} · {formatTndMinor(o.grossTotal, language)} TND</Text>
          ))}
        </View>

        <Text style={ui.section}>{t('customers.recentInvoices')}</Text>
        <View style={ui.card}>
          {data.recentInvoices.length === 0 ? <Text style={ui.muted}>—</Text> : data.recentInvoices.map((i) => (
            <Text key={i.id}>{i.isCreditNote ? `${t('customers.creditNote')} ` : ''}{i.number} · {i.issueDate ?? ''}
              {i.dueDate ? ` → ${i.dueDate}` : ''} · {formatTndMinor(i.grossTotal, language)} TND</Text>
          ))}
        </View>

        {canWrite('customer.manage') ? (
          <Pressable style={ui.primary} onPress={() => router.push({ pathname: '/customers/edit', params: { id: c.id } } as never)}>
            <Text style={ui.primaryText}>{t('customers.edit')}</Text>
          </Pressable>
        ) : null}
        <Pressable onPress={() => router.back()}><Text style={ui.link}>{t('back')}</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
