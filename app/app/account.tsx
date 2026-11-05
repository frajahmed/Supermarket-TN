import { useState } from 'react';
import { Linking, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../src/core/api-client';
import { groupSecret, isTotpCode } from '../src/core/users';
import { getApi } from '../src/device/session';
import { ui } from '../src/ui/styles';
import { LicenseBanner, useProfile } from '../src/ui/useProfile';
import { BackLink, LoadingScreen, Messages, PrimaryButton, ScreenScroll, SecondaryButton } from '../src/ui/components';

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

  if (!profile) return <LoadingScreen />;
  const canUseTotp = profile.user.role === 'owner' || profile.user.role === 'manager';
  const configured = profile.user.totpConfigured;

  return (
    <ScreenScroll>
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
              <PrimaryButton label={t('account.totpStart')} onPress={() => void start()} disabled={busy} />
            </>
          ) : null}
          {setup ? (
            <>
              <Text>{t('account.step1')}</Text>
              <SecondaryButton label={t('account.openAuthenticator')} onPress={() => void Linking.openURL(setup.otpauthUri).catch(() => setMessage(t('account.noAuthenticator')))} />
              <Text style={ui.muted}>{t('account.manualKey')}</Text>
              <Text selectable style={{ fontFamily: 'monospace', fontSize: 18, letterSpacing: 1 }}>{groupSecret(setup.secret)}</Text>
              <Text>{t('account.step2', { minutes: Math.round(setup.expiresIn / 60) })}</Text>
              <TextInput value={code} onChangeText={setCode} keyboardType="number-pad" maxLength={6} style={ui.input} placeholder="123456" />
              <PrimaryButton label={t('account.totpConfirm')} onPress={() => void confirm()} disabled={busy} />
            </>
          ) : null}
        </View>
      ) : null}
      <Messages info={info} error={message} />
      <BackLink />
    </ScreenScroll>
  );
}
