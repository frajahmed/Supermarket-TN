import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import type { Customer } from '../core/customers';
import { getApi } from '../device/session';
import { SecondaryButton } from './components';
import { ui } from './styles';

export function CustomerPicker({ value, onChange, onError }: {
  value: Customer | null; onChange: (c: Customer | null) => void; onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Customer[]>([]);

  async function find() {
    try {
      const q = encodeURIComponent(query.trim());
      setHits((await (await getApi()).get<{ items: Customer[] }>(`/api/v1/customers?limit=20${q ? `&q=${q}` : ''}`)).items);
    } catch {
      onError(t('customers.loadFailed'));
    }
  }

  if (value) {
    return (
      <View style={[ui.card, ui.row]}>
        <Text style={{ flex: 1, fontWeight: '700' }}>{value.name} · {value.number}</Text>
        <Pressable onPress={() => onChange(null)}><Text style={ui.link}>{t('orders.change')}</Text></Pressable>
      </View>
    );
  }
  return (
    <>
      <View style={ui.row}>
        <TextInput value={query} onChangeText={setQuery} placeholder={t('customers.search')} style={ui.input}
          returnKeyType="search" onSubmitEditing={() => void find()} />
        <SecondaryButton label={t('orders.find')} onPress={() => void find()} />
      </View>
      {hits.map((c) => (
        <Pressable key={c.id} style={ui.card} onPress={() => { onChange(c); setHits([]); }}>
          <Text style={{ fontWeight: '700' }}>{c.name}</Text>
          <Text style={ui.muted}>{c.number}{c.billingAddress.city ? ` · ${c.billingAddress.city}` : ''}</Text>
        </Pressable>
      ))}
    </>
  );
}
