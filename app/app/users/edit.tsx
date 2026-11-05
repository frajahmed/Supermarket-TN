import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { Pressable, Switch, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../src/core/api-client';
import { assignableRoles, userBody, type User, type UserForm, type UserFormError } from '../../src/core/users';
import { getApi } from '../../src/device/session';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';
import { BackLink, LoadingScreen, Messages, PrimaryButton, ScreenScroll, SecondaryButton } from '../../src/ui/components';

const EMPTY: UserForm = { email: '', displayName: '', role: 'cashier', password: '', pin: '', storeIds: [], isActive: true };

export default function UserEditScreen() {
  const { t } = useTranslation();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const { profile, storeId, canWrite } = useProfile();
  const [form, setForm] = useState<UserForm>(EMPTY);
  const [initial, setInitial] = useState<UserForm | null>(null);
  const [totpConfigured, setTotpConfigured] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof UserForm, UserFormError>>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!profile) return;
    if (!id) { setForm((f) => ({ ...f, storeIds: storeId ? [storeId] : [] })); return; }
    void (async () => {
      try {
        const u = (await (await getApi()).get<{ items: User[] }>('/api/v1/users')).items.find((x) => x.id === id);
        if (!u) { setMessage(t('users.loadFailed')); return; }
        const f: UserForm = { email: u.email, displayName: u.displayName, role: u.role, password: '', pin: '', storeIds: u.storeIds, isActive: u.isActive };
        setForm(f); setInitial(f); setTotpConfigured(u.totpConfigured);
      } catch {
        setMessage(t('users.loadFailed'));
      }
    })();
  }, [id, profile, storeId, t]);

  const set = <K extends keyof UserForm>(k: K, v: UserForm[K]) => setForm((f) => ({ ...f, [k]: v }));

  async function send(body: Record<string, unknown>) {
    setBusy(true); setMessage('');
    try {
      const api = await getApi();
      if (id) { if (Object.keys(body).length) await api.patch(`/api/v1/users/${id}`, body); }
      else await api.post('/api/v1/users', body);
      router.back();
    } catch (e) {
      setMessage(e instanceof ApiError ? e.message : t('products.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  function save() {
    if (!profile) return;
    const r = userBody(form, { myRole: profile.user.role, mode: id ? 'edit' : 'create', initial: initial ?? undefined });
    if (!r.ok) { setErrors(r.errors); return; }
    setErrors({});
    void send(r.body);
  }

  if (!profile || (id && !initial && !message)) return <LoadingScreen />;
  const writable = canWrite('user.manage');
  const err = (k: keyof UserForm) => (errors[k] ? <Text style={ui.error}>{t(`users.errors.${errors[k]}`)}</Text> : null);
  const isPinRole = form.role === 'cashier' || form.role === 'stock_clerk';

  return (
    <ScreenScroll>
      <Text style={ui.title}>{id ? t('users.edit') : t('users.create')}</Text>
      <LicenseBanner profile={profile} />
      <Text>{t('email')}</Text>
      <TextInput value={form.email} onChangeText={(v) => set('email', v)} style={[ui.input, id ? ui.disabled : null]} editable={!id && writable}
        autoCapitalize="none" keyboardType="email-address" />
      {err('email')}
      <Text>{t('users.name')}</Text>
      <TextInput value={form.displayName} onChangeText={(v) => set('displayName', v)} style={ui.input} editable={writable} />
      {err('displayName')}

      <Text>{t('users.role')}</Text>
      <View style={ui.row}>
        {assignableRoles(profile.user.role).map((r) => (
          <Pressable key={r} style={[ui.chip, form.role === r && ui.chipActive]} onPress={() => writable && set('role', r)}>
            <Text style={form.role === r ? ui.chipActiveText : undefined}>{t(`role.${r}`)}</Text>
          </Pressable>
        ))}
      </View>
      {err('role')}

      {form.role !== 'owner' ? (
        <>
          <Text>{t('users.stores')}</Text>
          <View style={ui.row}>
            {profile.stores.map((s) => {
              const on = form.storeIds.includes(s.id);
              return (
                <Pressable key={s.id} style={[ui.chip, on && ui.chipActive]}
                  onPress={() => writable && set('storeIds', on ? form.storeIds.filter((x) => x !== s.id) : [...form.storeIds, s.id])}>
                  <Text style={on ? ui.chipActiveText : undefined}>{s.code} · {s.name}</Text>
                </Pressable>
              );
            })}
          </View>
          {err('storeIds')}
        </>
      ) : null}

      <Text>{t('password')}{id ? ` (${t('users.emptyUnchanged')})` : ''}</Text>
      <TextInput value={form.password} onChangeText={(v) => set('password', v)} style={ui.input} secureTextEntry editable={writable} />
      {err('password')}
      {isPinRole ? (
        <>
          <Text>{t('pin')}{id ? ` (${t('users.emptyUnchanged')})` : ''}</Text>
          <TextInput value={form.pin} onChangeText={(v) => set('pin', v)} style={ui.input} keyboardType="number-pad" secureTextEntry maxLength={8} editable={writable} />
          {err('pin')}
        </>
      ) : null}

      {id ? (
        <>
          <View style={ui.row}>
            <Switch value={form.isActive} onValueChange={(v) => set('isActive', v)} disabled={!writable} />
            <Text>{form.isActive ? t('users.active') : t('users.inactive')}</Text>
          </View>
          {totpConfigured ? (
            <SecondaryButton label={t('users.resetTotp')} onPress={() => void send({ totpSecret: null })} disabled={!writable || busy} />
          ) : null}
        </>
      ) : null}

      <Messages error={message} />
      <PrimaryButton label={t('products.save')} onPress={save} busy={busy} disabled={!writable} />
      <BackLink />
    </ScreenScroll>
  );
}
