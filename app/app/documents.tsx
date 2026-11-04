import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatTndMinor } from '../src/core/money';
import { documentFileName, documentPath, type DocumentKind } from '../src/core/orders';
import { getApi } from '../src/device/session';
import { useLanguage } from '../src/i18n/LanguageProvider';
import { ui } from '../src/ui/styles';

interface InvoiceSummary { number: string; customerName: string; issueDate: string | null; dueDate: string | null;
  netTotal: string; taxTotal: string; stampDuty: string; grossTotal: string; isCreditNote: boolean }

/**
 * Lieferschein / Rechnung (T-112): Der Server erzeugt das zweisprachige HTML (fr + ar);
 * expo-print rendert es mit der Schrift des Geräts – damit wird Arabisch korrekt verbunden.
 */
export default function DocumentScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const params = useLocalSearchParams<{ kind: DocumentKind; id: string; number?: string; query?: string }>();
  const [html, setHtml] = useState<string | null>(null);
  const [summary, setSummary] = useState<InvoiceSummary | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const api = await getApi();
        setHtml(await api.text(documentPath(params.kind, params.id, params.query ?? '')));
        if (params.kind === 'invoice') setSummary(await api.get<InvoiceSummary>(`/api/v1/invoices/${params.id}`));
      } catch {
        setMessage(t('orders.documentFailed'));
      }
    })();
  }, [params.kind, params.id, params.query, t]);

  const number = summary?.number || params.number || params.id;

  async function print() {
    if (!html) return;
    setBusy(true);
    try { await Print.printAsync({ html }); } catch { setMessage(t('orders.printFailed')); } finally { setBusy(false); }
  }

  async function share() {
    if (!html) return;
    setBusy(true);
    try {
      const { uri } = await Print.printToFileAsync({ html });
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf', dialogTitle: documentFileName(number) });
      } else setMessage(t('orders.shareUnavailable'));
    } catch {
      setMessage(t('orders.printFailed'));
    } finally {
      setBusy(false);
    }
  }

  const money = (v: string) => `${formatTndMinor(v, language)} TND`;
  return (
    <SafeAreaView style={ui.safe}>
      <ScrollView contentContainerStyle={ui.container}>
        <Text style={ui.title}>{params.kind === 'invoice' ? t('orders.invoice') : params.kind === 'statement' ? t('payments.statement') : t('orders.deliveryNote')} {number}</Text>
        {summary ? (
          <View style={ui.card}>
            <Text style={{ fontWeight: '700' }}>{summary.customerName}</Text>
            <Text>{summary.issueDate ?? ''}{summary.dueDate ? ` → ${summary.dueDate}` : ''}</Text>
            <Text>{t('orders.net')}: {money(summary.netTotal)}</Text>
            <Text>{t('products.tax')}: {money(summary.taxTotal)}</Text>
            <Text>{t('orders.stamp')}: {money(summary.stampDuty)}</Text>
            <Text style={{ fontWeight: '700' }}>{t('orders.gross')}: {money(summary.grossTotal)}</Text>
          </View>
        ) : null}
        {!html && !message ? <ActivityIndicator /> : null}
        {html ? (
          <View style={ui.row}>
            <Pressable style={[ui.primary, busy && ui.disabled]} disabled={busy} onPress={() => void print()}>
              <Text style={ui.primaryText}>{t('orders.print')}</Text>
            </Pressable>
            <Pressable style={[ui.secondary, busy && ui.disabled]} disabled={busy} onPress={() => void share()}>
              <Text style={ui.secondaryText}>{t('orders.sharePdf')}</Text>
            </Pressable>
          </View>
        ) : null}
        {message ? <Text style={ui.error} accessibilityRole="alert">{message}</Text> : null}
        <Pressable onPress={() => router.back()}><Text style={ui.link}>{t('back')}</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
