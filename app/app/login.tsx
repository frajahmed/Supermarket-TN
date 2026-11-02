import { useState } from 'react';
import { Link } from 'expo-router';
import { Pressable, SafeAreaView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { CustomerServerClient } from '../src/api/customer-server';
import { loadOrCreateDeviceIdentity, saveAuthSession } from '../src/device/runtime';

export default function LoginScreen() {
  const { t } = useTranslation();
  const [serverUrl, setServerUrl] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pin, setPin] = useState('');
  const [totp, setTotp] = useState('');
  const [pinMode, setPinMode] = useState(false);
  const [message, setMessage] = useState('');

  async function login() {
    try {
      const identity = await loadOrCreateDeviceIdentity();
      const session = await new CustomerServerClient(serverUrl.trim()).login(identity, pinMode
        ? { email, pin, totp: totp || undefined }
        : { email, password, totp: totp || undefined });
      await saveAuthSession(session);
      setMessage('Anmeldung erfolgreich');
    } catch {
      setMessage('Anmeldung fehlgeschlagen');
    }
  }

  return (
    <SafeAreaView style={styles.safe}><View style={styles.container}>
      <Text style={styles.title}>{t('login')}</Text>
      <TextInput value={serverUrl} onChangeText={setServerUrl} autoCapitalize="none" keyboardType="url" placeholder={t('serverUrl')} style={styles.input} />
      <TextInput value={email} onChangeText={setEmail} autoCapitalize="none" keyboardType="email-address" placeholder={t('email')} style={styles.input} />
      {pinMode
        ? <TextInput value={pin} onChangeText={setPin} keyboardType="number-pad" secureTextEntry placeholder={t('pin')} style={styles.input} />
        : <TextInput value={password} onChangeText={setPassword} secureTextEntry placeholder={t('password')} style={styles.input} />}
      <TextInput value={totp} onChangeText={setTotp} keyboardType="number-pad" maxLength={6} placeholder={t('totp')} style={styles.input} />
      <Pressable onPress={() => setPinMode((value) => !value)}><Text>{pinMode ? t('password') : t('pin')}</Text></Pressable>
      <Pressable style={styles.primary} onPress={() => void login()}><Text style={styles.primaryText}>{t('login')}</Text></Pressable>
      {message ? <Text>{message}</Text> : null}
      <Link href="/" style={styles.link}>Zurück</Link>
    </View></SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 }, container: { flex: 1, padding: 24, gap: 14, justifyContent: 'center' },
  title: { fontSize: 28, fontWeight: '700' }, input: { borderWidth: 1, borderColor: '#999', borderRadius: 8, padding: 12 },
  primary: { backgroundColor: '#176b87', borderRadius: 8, padding: 14, alignItems: 'center' }, primaryText: { color: 'white', fontWeight: '700' },
  link: { textAlign: 'center' },
});
