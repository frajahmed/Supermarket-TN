import { useEffect, useRef, useState } from 'react';
import { Link, router } from 'expo-router';
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { CustomerServerClient } from '../src/api/customer-server';
import { activationStatusKey, nextActivationStep } from '../src/core/activation';
import { normalizeServerUrl, ServerUrlError } from '../src/core/server-url';
import {
  loadOrCreateDeviceIdentity, loadServerUrl, saveDeviceCertificate, saveServerUrl,
} from '../src/device/runtime';

const POLL_MS = 5000;
const KINDS = ['phone', 'scanner', 'tablet', 'pos'] as const;
type DeviceKind = (typeof KINDS)[number];

export default function SetupScreen() {
  const { t } = useTranslation();
  const [serverUrl, setServerUrl] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [kind, setKind] = useState<DeviceKind>('phone');
  const [code, setCode] = useState('');
  const [polling, setPolling] = useState<{ licenseServerUrl: string; requestId: string } | null>(null);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => { void loadServerUrl().then((u) => { if (u) setServerUrl(u); }); }, []);

  // Status abfragen, bis freigegeben (-> Anmeldung) oder abgelehnt; dann aufhören
  useEffect(() => {
    if (!polling) return undefined;
    const client = new CustomerServerClient(serverUrl);
    const tick = async () => {
      try {
        const result = await client.activationStatus(polling.licenseServerUrl, polling.requestId);
        setStatus(result.status);
        setError('');
        if (result.certificate) await saveDeviceCertificate(result.certificate);
        const next = nextActivationStep(result.status, Boolean(result.certificate));
        if (next !== 'wait') {
          if (timer.current) clearInterval(timer.current);
          setPolling(null);
          if (next === 'done') router.replace('/login');
        }
      } catch {
        setError(t('errors.serverUnreachable'));
      }
    };
    timer.current = setInterval(() => void tick(), POLL_MS);
    return () => { if (timer.current) clearInterval(timer.current); };
  }, [polling, serverUrl, t]);

  async function startSetup() {
    setError('');
    setBusy(true);
    try {
      const normalized = normalizeServerUrl(serverUrl, { allowInsecure: __DEV__ });
      const client = new CustomerServerClient(normalized);
      const info = await client.setupInfo();
      const identity = await loadOrCreateDeviceIdentity();
      const activation = await client.requestActivation(info.licenseServerUrl, info.installationId, identity,
        deviceName.trim() || t(`deviceKind.${kind}`), kind);
      await saveServerUrl(normalized);
      setServerUrl(normalized);
      setCode(activation.activationCode);
      setStatus(activation.status);
      if (activation.status === 'pending') setPolling({ licenseServerUrl: info.licenseServerUrl, requestId: activation.requestId });
    } catch (e) {
      if (e instanceof ServerUrlError) setError(t(e.reason === 'https_required' ? 'errors.httpsRequired' : 'errors.invalidServerUrl'));
      else if (e instanceof TypeError) setError(t('errors.serverUnreachable'));
      else setError(t('errors.setupFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}><View style={styles.container}>
      <Text style={styles.title}>{t('setup')}</Text>
      <TextInput value={serverUrl} onChangeText={setServerUrl} autoCapitalize="none" autoCorrect={false}
        keyboardType="url" placeholder={t('serverUrl')} style={styles.input} editable={!code} />
      <TextInput value={deviceName} onChangeText={setDeviceName} placeholder={t('deviceName')} style={styles.input} editable={!code} />
      {!code ? (
        <View style={styles.kinds}>
          {KINDS.map((k) => (
            <Pressable key={k} accessibilityRole="button" accessibilityState={{ selected: k === kind }}
              style={[styles.kind, k === kind && styles.kindActive]} onPress={() => setKind(k)}>
              <Text>{t(`deviceKind.${k}`)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {!code ? (
        <Pressable style={[styles.primary, busy && styles.disabled]} disabled={busy} onPress={() => void startSetup()}>
          {busy ? <ActivityIndicator color="white" /> : <Text style={styles.primaryText}>{t('setup')}</Text>}
        </Pressable>
      ) : (
        <View accessibilityLabel="activation-code" style={styles.codeBox}>
          <Text>{t('activationCode')}</Text>
          <Text style={styles.code} selectable>{code}</Text>
          <Text>{t(activationStatusKey(status))}</Text>
          {polling ? <ActivityIndicator /> : null}
        </View>
      )}
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
      <Link href="/" style={styles.link}>{t('back')}</Link>
    </View></SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 }, container: { flex: 1, padding: 24, gap: 14, justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '700' }, input: { borderWidth: 1, borderColor: '#999', borderRadius: 8, padding: 12 },
  primary: { backgroundColor: '#176b87', borderRadius: 8, padding: 14, alignItems: 'center' }, primaryText: { color: 'white', fontWeight: '700' },
  kinds: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  kind: { borderWidth: 1, borderColor: '#999', borderRadius: 6, paddingVertical: 8, paddingHorizontal: 12 },
  kindActive: { borderColor: '#176b87', borderWidth: 2 },
  disabled: { opacity: 0.6 }, codeBox: { alignItems: 'center', gap: 6 },
  code: { fontSize: 34, fontWeight: '800', letterSpacing: 3, textAlign: 'center', paddingVertical: 16 },
  error: { color: '#b42318' }, link: { textAlign: 'center' },
});
