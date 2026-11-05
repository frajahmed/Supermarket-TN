import { useCallback, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../src/core/api-client';
import { canRevoke, type Device } from '../../src/core/users';
import { getApi } from '../../src/device/session';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';
import { BackLink, LoadingScreen, Messages, ScreenScroll, SecondaryButton } from '../../src/ui/components';

export default function DevicesScreen() {
  const { t } = useTranslation();
  const { profile, canWrite } = useProfile();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try { setDevices((await (await getApi()).get<{ items: Device[] }>('/api/v1/devices')).items); } catch { setMessage(t('devices.loadFailed')); }
  }, [t]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  async function act(fn: () => Promise<unknown>) {
    setMessage('');
    try { await fn(); setEditing(null); setConfirming(null); await load(); }
    catch (e) { setMessage(e instanceof ApiError ? e.message : t('errors.serverUnreachable')); }
  }
  const patch = (id: string, body: Record<string, unknown>) => act(async () => (await getApi()).patch(`/api/v1/devices/${id}`, body));
  const revoke = (id: string) => act(async () => (await getApi()).post(`/api/v1/devices/${id}/revoke`, {}));

  if (!profile || !devices) return <LoadingScreen error={message} />;
  const writable = canWrite('device.manage');

  return (
    <ScreenScroll>
      <Text style={ui.title}>{t('tiles.devices')}</Text>
      <LicenseBanner profile={profile} />
      <Text style={ui.muted}>{t('devices.hint')}</Text>
      {devices.map((d) => (
        <View key={d.id} style={[ui.card, { gap: 8 }, d.revokedAt ? ui.disabled : null]}>
          <View style={ui.row}>
            <Text style={{ fontWeight: '700', flex: 1 }}>{d.name}</Text>
            <Text style={[ui.badge, ui.warn]}>{t(`deviceKind.${d.kind}`, { defaultValue: d.kind })}</Text>
            {d.isCurrent ? <Text style={[ui.badge, { backgroundColor: '#e2f2e5', color: '#1d6b2f' }]}>{t('devices.thisDevice')}</Text> : null}
            {d.revokedAt ? <Text style={[ui.badge, ui.danger]}>{t('devices.revoked')}</Text> : null}
          </View>
          <Text style={ui.muted}>
            {d.storeName ?? t('devices.noStore')} · {t('devices.lastSeen')}: {d.lastSeenAt ? d.lastSeenAt.slice(0, 16).replace('T', ' ') : '—'}
            {d.lastUserName ? ` · ${d.lastUserName}` : ''}
          </Text>
          {writable && !d.revokedAt ? (
            <View style={ui.row}>
              {profile.stores.map((s) => (
                <Pressable key={s.id} style={[ui.chip, d.storeId === s.id && ui.chipActive]} onPress={() => void patch(d.id, { storeId: s.id })}>
                  <Text style={d.storeId === s.id ? ui.chipActiveText : undefined}>{s.code}</Text>
                </Pressable>
              ))}
              <Pressable onPress={() => { setEditing(d.id); setName(d.name); }}><Text style={ui.link}>{t('devices.rename')}</Text></Pressable>
              {canRevoke(d) && confirming !== d.id ? <Pressable onPress={() => setConfirming(d.id)}><Text style={ui.error}>{t('devices.revoke')}</Text></Pressable> : null}
            </View>
          ) : null}
          {editing === d.id ? (
            <View style={ui.row}>
              <TextInput value={name} onChangeText={setName} style={ui.input} maxLength={100} />
              <Pressable style={ui.secondary} onPress={() => void patch(d.id, { name: name.trim() })}><Text style={ui.secondaryText}>OK</Text></Pressable>
            </View>
          ) : null}
          {confirming === d.id ? (
            <View style={[ui.row, { gap: 12 }]}>
              <Text style={[ui.error, { flex: 1 }]}>{t('devices.revokeConfirm')}</Text>
              <SecondaryButton label={t('devices.revoke')} onPress={() => void revoke(d.id)} />
              <Pressable onPress={() => setConfirming(null)}><Text style={ui.link}>{t('back')}</Text></Pressable>
            </View>
          ) : null}
        </View>
      ))}
      <Messages error={message} />
      <BackLink />
    </ScreenScroll>
  );
}
