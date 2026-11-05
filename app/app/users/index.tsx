import { useCallback, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { canEditUser, type User } from '../../src/core/users';
import { getApi } from '../../src/device/session';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';

export default function UsersScreen() {
  const { t } = useTranslation();
  const { profile, canWrite } = useProfile();
  const [users, setUsers] = useState<User[] | null>(null);
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    try { setUsers((await (await getApi()).get<{ items: User[] }>('/api/v1/users')).items); } catch { setMessage(t('users.loadFailed')); }
  }, [t]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  if (!profile || !users) return <SafeAreaView style={ui.safe}><View style={ui.center}>{message ? <Text style={ui.error}>{message}</Text> : <ActivityIndicator />}</View></SafeAreaView>;
  const storeName = (id: string) => profile.stores.find((s) => s.id === id)?.code ?? '?';

  return (
    <SafeAreaView style={ui.safe}>
      <ScrollView contentContainerStyle={ui.container}>
        <View style={ui.row}>
          <Text style={[ui.title, { flex: 1 }]}>{t('tiles.users')}</Text>
          {canWrite('user.manage') ? (
            <Pressable style={ui.primary} onPress={() => router.push('/users/edit' as never)}><Text style={ui.primaryText}>{t('users.create')}</Text></Pressable>
          ) : null}
        </View>
        <LicenseBanner profile={profile} />
        {users.map((u) => (
          <Pressable key={u.id} style={[ui.card, !u.isActive && ui.disabled]} disabled={!canEditUser(profile.user.role, u)}
            onPress={() => router.push({ pathname: '/users/edit', params: { id: u.id } } as never)}>
            <View style={ui.row}>
              <Text style={{ fontWeight: '700', flex: 1 }}>{u.displayName}</Text>
              <Text style={[ui.badge, ui.warn]}>{t(`role.${u.role}`)}</Text>
              {u.totpConfigured ? <Text style={[ui.badge, { backgroundColor: '#e2f2e5', color: '#1d6b2f' }]}>2FA</Text> : null}
              {!u.isActive ? <Text style={[ui.badge, ui.danger]}>{t('users.inactive')}</Text> : null}
            </View>
            <Text style={ui.muted}>{u.email}{u.storeIds.length ? ` · ${u.storeIds.map(storeName).join(', ')}` : ''}</Text>
          </Pressable>
        ))}
        <Pressable onPress={() => router.back()}><Text style={ui.link}>{t('back')}</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
