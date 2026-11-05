import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatTndMinor } from '../../core/money';
import { lineAmounts, parsePercent, type CartLine } from '../../core/pos';
import { useLanguage } from '../../i18n/LanguageProvider';
import { SecondaryButton } from '../components';
import { ui } from '../styles';

export function CartLineRow({ line, limitBp, onChange, onRemove, onError }: {
  line: CartLine; limitBp: number; onChange: (patch: Partial<CartLine>) => void; onRemove: () => void; onError: (message: string) => void;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const [discountText, setDiscountText] = useState<string | null>(null);
  const money = (v: string | bigint) => formatTndMinor(String(v), language);
  let total: string;
  try { total = money(lineAmounts(line).total); } catch { total = '?'; }

  function applyDiscount() {
    const bp = parsePercent(discountText ?? '');
    if (bp === null) { onError(t('pos.errors.invalidDiscount')); return; }
    onChange({ discountBp: bp });
    setDiscountText(null);
  }

  return (
    <View style={ui.card}>
      <View style={ui.row}>
        <Text style={{ fontWeight: '700', flex: 1 }}>{line.label}</Text>
        <Text style={{ fontWeight: '700' }}>{total}</Text>
      </View>
      <View style={ui.row}>
        <TextInput value={line.quantity} onChangeText={(v) => onChange({ quantity: v.replace(',', '.') })} keyboardType="decimal-pad"
          style={[ui.input, { flexGrow: 0, minWidth: 70 }]} accessibilityLabel={t('orders.quantity')} />
        <Text>× {money(line.unitPrice)}</Text>
        {line.discountBp ? <Text style={[ui.badge, line.discountBp > limitBp ? ui.danger : ui.warn]}>−{line.discountBp / 100} %</Text> : null}
        <Pressable onPress={() => setDiscountText(line.discountBp ? String(line.discountBp / 100) : '')}>
          <Text style={ui.link}>{t('pos.discount')}</Text>
        </Pressable>
        <Pressable onPress={onRemove}><Text style={ui.error}>{t('orders.remove')}</Text></Pressable>
      </View>
      {discountText !== null ? (
        <View style={ui.row}>
          <TextInput value={discountText} onChangeText={setDiscountText} keyboardType="decimal-pad" placeholder="%" style={[ui.input, { flexGrow: 0, minWidth: 70 }]} />
          <SecondaryButton label="OK" onPress={applyDiscount} />
          <Text style={ui.muted}>{t('pos.limit', { limit: limitBp / 100 })}</Text>
        </View>
      ) : null}
    </View>
  );
}
