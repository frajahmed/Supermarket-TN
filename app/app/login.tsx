import { useEffect, useState } from 'react';
import { Link, router } from 'expo-router';
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { CustomerServerClient, ServerError } from '../src/api/customer-server';
import { loadOrCreateDeviceIdentity, loadServerUrl, saveAuthSession } from '../src/device/runtime';

export default function LoginScreen() {
  const { t } = useTranslation();
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [totp, setTotp] = useState('');
  const [pinMode, setPinMode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { void loadServerUrl().then(setServerUrl); }, []);

  async function login() {
    if (!serverUrl) { setError(t('errors.notActivated')); return; }
    setError('');
    setBusy(true);
    try {
      const identity = await loadOrCreateDeviceIdentity();
      const session = await new CustomerServerClient(serverUrl).login(identity, pinMode
        ? { email: email.trim(), pin, totp: totp || undefined }
        : { email: email.trim(), password, totp: totp || undefined });
      await saveAuthSession(session);
      setPassword(''); setPin(''); setTotp('');
      router.replace('/license');
    } catch (e) {
      if (e instanceof ServerError && e.status === 423) setError(t('locked'));
      else if (e instanceof ServerError && /TOTP-Code erforderlich/u.test(e.message)) setError(t('totpRequired'));
      else if (e instanceof ServerError) setError(t('loginFailed'));
      else setError(t('errors.serverUnreachable'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SafeAreaView style={styles.safe}><View style={styles.container}>
      <Text style={styles.title}>{t('login')}</Text>
      <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" autoCorrect={false}
        keyboardType="email-address" placeholder={t('email')} style={styles.input} />
      {pinMode
        ? <TextInput value={pin} onChangeText={setPin} keyboardType="number-pad" secureTextEntry maxLength={8} placeholder={t('pin')} style={styles.input} />
        : <TextInput value={password} onChangeText={setPassword} secureTextEntry placeholder={t('password')} style={styles.input} />}
      <TextInput value={totp} onChangeText={setTotp} keyboardType="number-pad" maxLength={6} placeholder={t('totp')} style={styles.input} />
      <Pressable onPress={() => setPinMode((value) => !value)}><Text style={styles.link}>{pinMode ? t('usePassword') : t('usePin')}</Text></Pressable>
      <Pressable style={[styles.primary, busy && styles.disabled]} disabled={busy} onPress={() => void login()}>
        {busy ? <ActivityIndicator color="white" /> : <Text style={styles.primaryText}>{t('login')}</Text>}
      </Pressable>
      {error ? <Text style={styles.error} accessibilityRole="alert">{error}</Text> : null}
      <Link href="/" style={styles.link}>{t('back')}</Link>
    </View></SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 }, container: { flex: 1, padding: 24, gap: 14, justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '700' }, input: { borderWidth: 1, borderColor: '#999', borderRadius: 8, padding: 12 },
  primary: { backgroundColor: '#176b87', borderRadius: 8, padding: 14, alignItems: 'center' }, primaryText: { color: 'white', fontWeight: '700' },
  disabled: { opacity: 0.6 }, error: { color: '#b42318' }, link: { textAlign: 'center' },
});
