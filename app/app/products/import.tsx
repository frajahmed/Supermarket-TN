import { useState } from 'react';
import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../src/core/api-client';
import { importTemplateCsv, rowsFromCsv, type ImportParseResult } from '../../src/core/product-import';
import { getApi } from '../../src/device/session';
import { BackLink, LoadingScreen, Messages, PrimaryButton, ScreenScroll, SecondaryButton } from '../../src/ui/components';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';

interface ServerResult { mode: 'check' | 'apply'; applied: boolean; created: number; updated: number; errors: Array<{ line: number; message: string }> }

const MAX_ROWS = 5000;
const SHOWN_ERRORS = 50;

export default function ProductImportScreen() {
  const { t } = useTranslation();
  const { profile, can, canWrite } = useProfile();
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ImportParseResult | null>(null);
  const [server, setServer] = useState<ServerResult | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  async function shareTemplate() {
    try {
      const uri = `${FileSystem.cacheDirectory}modele-articles.csv`;
      await FileSystem.writeAsStringAsync(uri, importTemplateCsv());
      await Sharing.shareAsync(uri, { mimeType: 'text/csv', dialogTitle: 'modele-articles.csv' });
    } catch {
      setMessage(t('orders.shareUnavailable'));
    }
  }

  async function pickFile() {
    setMessage(''); setServer(null); setParsed(null);
    const picked = await DocumentPicker.getDocumentAsync({ type: ['text/csv', 'text/comma-separated-values', 'text/plain', 'application/vnd.ms-excel'], copyToCacheDirectory: true });
    if (picked.canceled || !picked.assets[0]) return;
    const text = await FileSystem.readAsStringAsync(picked.assets[0].uri);
    // Excel speichert „CSV“ ohne UTF-8 in Windows-1252 – arabische und französische Zeichen gingen verloren.
    if (text.includes('�')) { setMessage(t('import.encoding')); return; }
    setFileName(picked.assets[0].name);
    const result = rowsFromCsv(text);
    if (result.rows.length > MAX_ROWS) { setMessage(t('import.tooMany', { max: MAX_ROWS })); return; }
    if (result.withPrices && !can('price.update')) { setMessage(t('import.pricesNotAllowed')); return; }
    setParsed(result);
  }

  async function send(mode: 'check' | 'apply') {
    if (!parsed) return;
    setBusy(true); setMessage('');
    try {
      setServer(await (await getApi()).post<ServerResult>('/api/v1/products/import', { mode, rows: parsed.rows }));
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : t('errors.serverUnreachable'));
    } finally {
      setBusy(false);
    }
  }

  if (!profile) return <LoadingScreen />;
  const localErrors = parsed?.errors ?? [];
  const fileErrors = localErrors.filter((e) => e.field === 'file');
  const canApply = parsed && parsed.rows.length > 0 && localErrors.length === 0 && server?.mode === 'check' && server.errors.length === 0;

  return (
    <ScreenScroll>
      <Text style={ui.title}>{t('import.title')}</Text>
      <LicenseBanner profile={profile} />
      <Text>{t('import.explain')}</Text>
      <View style={ui.row}>
        <SecondaryButton label={t('import.template')} onPress={() => void shareTemplate()} />
        <PrimaryButton label={t('import.pickFile')} onPress={() => void pickFile()} disabled={!canWrite('product.write')} />
      </View>

      {parsed ? (
        <View style={[ui.card, { gap: 6 }]}>
          <Text style={{ fontWeight: '700' }}>{fileName}</Text>
          {fileErrors.map((e) => <Text key={e.code} style={ui.error}>{t(`import.errors.${e.code}`)}</Text>)}
          {!fileErrors.length ? <Text>{t('import.readRows', { ok: parsed.rows.length, bad: new Set(localErrors.map((e) => e.line)).size })}</Text> : null}
          {parsed.unknownColumns.length ? <Text style={ui.muted}>{t('import.ignoredColumns', { columns: parsed.unknownColumns.join(', ') })}</Text> : null}
          {localErrors.filter((e) => e.field !== 'file').slice(0, SHOWN_ERRORS).map((e, i) => (
            <Text key={i} style={ui.error}>{t('import.line', { n: e.line })}: {t(`import.fields.${e.field}`)} – {t(`import.errors.${e.code}`)}</Text>
          ))}
          {localErrors.length > SHOWN_ERRORS ? <Text style={ui.muted}>{t('import.moreErrors', { count: localErrors.length - SHOWN_ERRORS })}</Text> : null}
          {localErrors.length === 0 ? <SecondaryButton label={t('import.check')} onPress={() => void send('check')} disabled={busy} /> : <Text>{t('import.fixAndRetry')}</Text>}
        </View>
      ) : null}

      {server ? (
        <View style={[ui.card, { gap: 6, borderColor: server.errors.length ? '#9b1c15' : '#176b87' }]}>
          {server.applied
            ? <Text style={{ fontWeight: '700', color: '#176b87' }}>{t('import.done', { created: server.created, updated: server.updated })}</Text>
            : <Text style={{ fontWeight: '700' }}>{t('import.checked', { created: server.created, updated: server.updated })}</Text>}
          {server.errors.slice(0, SHOWN_ERRORS).map((e, i) => <Text key={i} style={ui.error}>{t('import.line', { n: e.line })}: {e.message}</Text>)}
          {server.errors.length ? <Text>{t('import.nothingSaved')}</Text> : null}
        </View>
      ) : null}

      {canApply ? <PrimaryButton label={t('import.apply', { count: parsed.rows.length })} onPress={() => void send('apply')} busy={busy} /> : null}
      <Messages error={message} />
      <BackLink />
    </ScreenScroll>
  );
}
