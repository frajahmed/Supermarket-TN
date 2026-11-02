import { useEffect, useState } from 'react';
import { Link } from 'expo-router';
import { Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { CustomerServerClient } from '../src/api/customer-server';
import { loadOrCreateDeviceIdentity, saveDeviceCertificate, saveServerUrl } from '../src/device/runtime';

export default function SetupScreen() {
  const { t } = useTranslation();
  const [serverUrl, setServerUrl] = useState('');
  const [deviceName, setDeviceName] = useState('Handy');
  const [code, setCode] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (!requestId || !serverUrl) return undefined;
    const timer = setInterval(() => {
      void (async () => {
        const client = new CustomerServerClient(serverUrl);
        const info = await client.setupInfo();
        const status = await client.activationStatus(info.licenseServerUrl, requestId);
        setMessage(status.status);
        if (status.certificate) await saveDeviceCertificate(status.certificate);
      })().catch(() => setMessage('Server nicht erreichbar'));
    }, 5000);
    return () => clearInterval(timer);
  }, [requestId, serverUrl]);

  async function startSetup() {
    setMessage('');
    const normalizedServerUrl = serverUrl.trim();
    const client = new CustomerServerClient(normalizedServerUrl);
    const info = await client.setupInfo();
    const identity = await loadOrCreateDeviceIdentity();
    const activation = await client.requestActivation(info.licenseServerUrl, info.installationId, identity, deviceName);
    await saveServerUrl(normalizedServerUrl);
    setCode(activation.activationCode);
    setRequestId(activation.requestId);
    setMessage(activation.status);
  }

  return (
    <SafeAreaView style={styles.safe}><View style={styles.container}>
      <Text style={styles.title}>{t('setup')}</Text>
      <TextInput value={serverUrl} onChangeText={setServerUrl} autoCapitalize="none" keyboardType="url" placeholder={t('serverUrl')} style={styles.input} />
      <TextInput value={deviceName} onChangeText={setDeviceName} placeholder={t('deviceName')} style={styles.input} />
      <Pressable style={styles.primary} onPress={() => void startSetup()}><Text style={styles.primaryText}>{t('setup')}</Text></Pressable>
      {code ? <View accessibilityLabel="activation-code"><Text>{t('activationCode')}</Text><Text style={styles.code}>{code}</Text><Text>{t('waitingApproval')}</Text></View> : null}
      {message ? <Text>{message}</Text> : null}
      <Link href="/" style={styles.link}>Zurück</Link>
    </View></SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 }, container: { flex: 1, padding: 24, gap: 14, justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '700' }, input: { borderWidth: 1, borderColor: '#999', borderRadius: 8, padding: 12 },
  primary: { backgroundColor: '#176b87', borderRadius: 8, padding: 14, alignItems: 'center' }, primaryText: { color: 'white', fontWeight: '700' },
  code: { fontSize: 34, fontWeight: '800', letterSpacing: 3, textAlign: 'center', paddingVertical: 16 }, link: { textAlign: 'center' },
});
