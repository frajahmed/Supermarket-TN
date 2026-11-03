import { useCallback, useRef, useState } from 'react';
import { router, useFocusEffect } from 'expo-router';
import { ActivityIndicator, FlatList, Pressable, SafeAreaView, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { creditState, type Customer } from '../../src/core/customers';
import { formatSignedTndMinor as formatSigned } from '../../src/core/money';
import { getApi } from '../../src/device/session';
import { useLanguage } from '../../src/i18n/LanguageProvider';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';

/** Kundenliste mit Suche (Name, Nummer, Matricule fiscal) – T-111. */
export default function CustomersScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { profile, canWrite } = useProfile();
  const [q, setQ] = useState('');
  const query = useRef('');
  query.current = q;
  const [items, setItems] = useState<Customer[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async (after: string | null = null) => {
    setBusy(true); setError('');
    try {
      const params = new URLSearchParams({ limit: '50' });
      if (query.current.trim()) params.set('q', query.current.trim());
      if (after) params.set('cursor', after);
      const page = await (await getApi()).get<{ items: Customer[]; nextCursor: string | null }>(`/api/v1/customers?${params.toString()}`);
      setItems((prev) => (after ? [...prev, ...page.items] : page.items));
      setCursor(page.nextCursor);
    } catch {
      setError(t('customers.loadFailed'));
    } finally {
      setBusy(false);
    }
  }, [t]);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  if (!profile) return <SafeAreaView style={ui.safe}><View style={ui.center}><ActivityIndicator /></View></SafeAreaView>;

  return (
    <SafeAreaView style={ui.safe}>
      <FlatList
        contentContainerStyle={ui.container}
        data={items}
        keyExtractor={(c) => c.id}
        ListHeaderComponent={
          <View style={{ gap: 12 }}>
            <Text style={ui.title}>{t('tiles.customers')}</Text>
            <LicenseBanner profile={profile} />
            <View style={ui.row}>
              <TextInput value={q} onChangeText={setQ} placeholder={t('customers.search')} style={ui.input}
                returnKeyType="search" onSubmitEditing={() => void load()} autoCorrect={false} />
              {canWrite('customer.manage') ? (
                <Pressable style={ui.primary} onPress={() => router.push('/customers/edit' as never)}>
                  <Text style={ui.primaryText}>{t('customers.create')}</Text>
                </Pressable>
              ) : null}
            </View>
            {error ? <Text style={ui.error} accessibilityRole="alert">{error}</Text> : null}
          </View>
        }
        ItemSeparatorComponent={() => <View style={{ height: 8 }} />}
        renderItem={({ item }) => {
          const credit = creditState(item.openBalance, item.creditLimit);
          return (
            <Pressable style={ui.card} accessibilityRole="button"
              onPress={() => router.push({ pathname: '/customers/[id]', params: { id: item.id } } as never)}>
              <Text style={{ fontWeight: '700' }}>{item.name}</Text>
              <Text style={ui.muted}>{item.number}{item.taxId ? ` · ${item.taxId}` : ''}{item.billingAddress.city ? ` · ${item.billingAddress.city}` : ''}</Text>
              <View style={ui.row}>
                <Text>{t('customers.openBalance')}: {formatSigned(item.openBalance, language)} TND</Text>
                {credit === 'over' || credit === 'near'
                  ? <Text style={[ui.badge, credit === 'over' ? ui.danger : ui.warn]}>{t(`customers.credit.${credit}`)}</Text> : null}
                {!item.isActive ? <Text style={[ui.badge, ui.warn]}>{t('products.inactive')}</Text> : null}
              </View>
            </Pressable>
          );
        }}
        ListEmptyComponent={busy ? null : <Text style={ui.muted}>{t('customers.empty')}</Text>}
        ListFooterComponent={busy ? <ActivityIndicator /> : cursor ? (
          <Pressable style={ui.secondary} onPress={() => void load(cursor)}><Text style={ui.secondaryText}>{t('products.more')}</Text></Pressable>
        ) : null}
      />
    </SafeAreaView>
  );
}
