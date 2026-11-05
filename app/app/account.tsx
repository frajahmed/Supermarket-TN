import { useState } from 'react';
import { router } from 'expo-router';
import { ActivityIndicator, Linking, Pressable, SafeAreaView, ScrollView, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../src/core/api-client';
import { groupSecret, isTotpCode } from '../src/core/users';
import { getApi } from '../src/device/session';
import { ui } from '../src/ui/styles';
import { LicenseBanner, useProfile } from '../src/ui/useProfile';

interface TotpSetup { secret: string; otpauthUri: string; expiresIn: number }

export default function AccountScreen() {
  const { t } = useTranslation();
  const { profile, reload } = useProfile();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [info, setInfo] = useState('');
  const [busy, setBusy] = useState(false);

  async function start() {
    setBusy(true); setMessage('');
    try { setSetup(await (await getApi()).post<TotpSetup>('/api/v1/me/2fa/setup', {})); }
    catch (e) { setMessage(e instanceof ApiError ? e.message : t('errors.serverUnreachable')); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!isTotpCode(code)) { setMessage(t('account.codeInvalid')); return; }
    setBusy(true); setMessage('');
    try {
      await (await getApi()).post('/api/v1/me/2fa/confirm', { code: code.trim() });
      setSetup(null); setCode(''); setInfo(t('account.totpActive'));
      await reload(true);
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : t('errors.serverUnreachable'));
    } finally {
      setBusy(false);
    }
  }

  if (!profile) return <SafeAreaView style={ui.safe}><View style={ui.center}><ActivityIndicator /></View></SafeAreaView>;
  const canUseTotp = profile.user.role === 'owner' || profile.user.role === 'manager';
  const configured = profile.user.totpConfigured;

  return (
    <SafeAreaView style={ui.safe}>
      <ScrollView contentContainerStyle={ui.container} keyboardShouldPersistTaps="handled">
        <Text style={ui.title}>{t('account.title')}</Text>
        <LicenseBanner profile={profile} />
        <View style={ui.card}>
          <Text style={{ fontWeight: '700' }}>{profile.user.displayName}</Text>
          <Text>{profile.user.email} · {t(`role.${profile.user.role}`)}</Text>
        </View>

        {canUseTotp ? (
          <View style={[ui.card, { gap: 10 }]}>
            <Text style={{ fontWeight: '700' }}>{t('account.totpTitle')}</Text>
            {configured && !setup ? <Text>{t('account.totpActive')}</Text> : null}
            {!configured && !setup ? (
              <>
                <Text>{t('account.totpExplain')}</Text>
                <Pressable style={[ui.primary, busy && ui.disabled]} disabled={busy} onPress={() => void start()}>
                  <Text style={ui.primaryText}>{t('account.totpStart')}</Text>
                </Pressable>
              </>
            ) : null}
            {setup ? (
              <>
                <Text>{t('account.step1')}</Text>
                <Pressable style={ui.secondary} onPress={() => void Linking.openURL(setup.otpauthUri).catch(() => setMessage(t('account.noAuthenticator')))}>
                  <Text style={ui.secondaryText}>{t('account.openAuthenticator')}</Text>
                </Pressable>
                <Text style={ui.muted}>{t('account.manualKey')}</Text>
                <Text selectable style={{ fontFamily: 'monospace', fontSize: 18, letterSpacing: 1 }}>{groupSecret(setup.secret)}</Text>
                <Text>{t('account.step2', { minutes: Math.round(setup.expiresIn / 60) })}</Text>
                <TextInput value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} style={ui.input} placeholder="123456" />
                <Pressable style={[ui.primary, busy && ui.disabled]} disabled={busy} onPress={() => void confirm()}>
                  <Text style={ui.primaryText}>{t('account.totpConfirm')}</Text>
                </Pressable>
              </>
            ) : null}
          </View>
        ) : null}
        {info ? <Text style={{ color: '#176b87', fontWeight: '700' }}>{info}</Text> : null}
        {message ? <Text style={ui.error} accessibilityRole="alert">{message}</Text> : null}
        <Pressable onPress={() => router.back()}><Text style={ui.link}>{t('back')}</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
