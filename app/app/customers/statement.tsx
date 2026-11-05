import { useCallback, useState } from 'react';
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatSignedTndMinor, formatTndMinor } from '../../src/core/money';
import { debitCredit, defaultStatementFrom, statementConsistent, type Statement } from '../../src/core/payments';
import { parseDateInput } from '../../src/core/warehouse';
import { getApi } from '../../src/device/session';
import { useLanguage } from '../../src/i18n/LanguageProvider';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';

export default function StatementScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useProfile();
  const today = new Date().toISOString().slice(0, 10);
  const [from, setFrom] = useState(defaultStatementFrom(today));
  const [data, setData] = useState<Statement | null>(null);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setMessage('');
    const f = from.trim() ? parseDateInput(from) : null;
    if (from.trim() && !f) { setMessage(t('warehouse.errors.invalidDate')); return; }
    try {
      setData(await (await getApi()).get<Statement>(`/api/v1/customers/${id}/statement${f ? `?from=${f}` : ''}`));
    } catch {
      setMessage(t('payments.statementFailed'));
    }
  }, [id, from, t]);
  // Nur beim Öffnen automatisch laden; ein geändertes Datum lädt per Knopf (sonst bei jedem Tastendruck)
  const initial = useCallback(() => { void load(); }, [id]);   // eslint-disable-line react-hooks/exhaustive-deps
  useFocusEffect(initial);

  const money = (v: string) => formatTndMinor(v, language);
  return (
    <SafeAreaView style={ui.safe}>
      <ScrollView contentContainerStyle={ui.container}>
        <Text style={ui.title}>{t('payments.statement')}</Text>
        <LicenseBanner profile={profile} />
        <View style={ui.row}>
          <TextInput value={from} onChangeText={setFrom} placeholder={t('payments.from')} style={ui.input} keyboardType="numbers-and-punctuation" />
          <Pressable style={ui.secondary} onPress={() => void load()}><Text style={ui.secondaryText}>{t('payments.show')}</Text></Pressable>
        </View>
        {message ? <Text style={ui.error}>{message}</Text> : null}
        {!data && !message ? <ActivityIndicator /> : null}
        {data ? (
          <>
            <Text style={{ fontWeight: '700' }}>{data.customer.name} · {data.customer.number}</Text>
            {!statementConsistent(data) ? <Text style={ui.error}>{t('payments.inconsistent')}</Text> : null}
            <View style={ui.card}><Text>{t('payments.opening')} ({data.from ?? '—'}): {formatSignedTndMinor(data.opening, language)} TND</Text></View>
            {data.entries.map((e) => {
              const dc = debitCredit(e.amount);
              return (
                <View key={`${e.kind}-${e.documentId}`} style={ui.card}>
                  <View style={ui.row}>
                    <Text style={{ fontWeight: '700', flex: 1 }}>
                      {t(`payments.kinds.${e.kind}`)} {e.kind.startsWith('payment') ? t(`payments.methods.${e.number ?? 'other'}`) : e.number}
                    </Text>
                    {e.reversed ? <Text style={[ui.badge, ui.warn]}>{t('payments.reversed')}</Text> : null}
                  </View>
                  <Text style={ui.muted}>{e.date}{e.reference ? ` · ${e.reference}` : ''}</Text>
                  <Text>{dc.debit ? `${t('payments.debit')} ${money(dc.debit)}` : `${t('payments.credit')} ${money(dc.credit ?? '0')}`}
                    {'  ·  '}{t('payments.balance')} {formatSignedTndMinor(e.balance, language)}</Text>
                </View>
              );
            })}
            <View style={[ui.card, { borderColor: '#176b87' }]}>
              <Text style={{ fontWeight: '700' }}>{t('payments.closing')} ({data.to}): {formatSignedTndMinor(data.closing, language)} TND</Text>
            </View>
            <Pressable style={ui.primary} onPress={() => router.push({ pathname: '/documents', params: {
              kind: 'statement', id: data.customer.id, number: `${data.customer.number}`, query: data.from ? `from=${data.from}` : '' } } as never)}>
              <Text style={ui.primaryText}>{t('payments.printStatement')}</Text>
            </Pressable>
          </>
        ) : null}
        <Pressable onPress={() => router.back()}><Text style={ui.link}>{t('back')}</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
