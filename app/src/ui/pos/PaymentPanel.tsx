import { Pressable, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatTndMinor } from '../../core/money';
import { cashSuggestions } from '../../core/pos';
import { moneyInputFromMinor, parseMoneyInput } from '../../core/products';
import { useLanguage } from '../../i18n/LanguageProvider';
import { Chip, Messages, PrimaryButton } from '../components';
import { ui } from '../styles';
import type { usePosSale } from './usePosSale';

export function PaymentPanel({ sale, canPay }: { sale: ReturnType<typeof usePosSale>; canPay: boolean }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const money = (v: string) => formatTndMinor(v, language);
  const cashMinor = parseMoneyInput(sale.cash);

  return (
    <View style={[ui.card, { gap: 10, borderColor: '#176b87' }]}>
      <Text style={{ fontSize: 24, fontWeight: '700' }}>{t('pos.total')}: {money(sale.totals.total)} TND</Text>
      {sale.totals.discount !== '0' ? <Text style={ui.muted}>{t('pos.discountTotal')}: {money(sale.totals.discount)}</Text> : null}
      <Text>{t('pos.cashGiven')}</Text>
      <View style={ui.row}>
        {cashSuggestions(sale.totals.total).map((s) => (
          <Chip key={s} label={money(s)} active={cashMinor === s} onPress={() => sale.setCash(moneyInputFromMinor(s))} />
        ))}
      </View>
      <TextInput value={sale.cash} onChangeText={sale.setCash} keyboardType="decimal-pad" placeholder={t('pos.cash')} style={ui.input} />
      <TextInput value={sale.card} onChangeText={sale.setCard} keyboardType="decimal-pad" placeholder={t('pos.card')} style={ui.input} />
      {sale.preview.ok && sale.preview.change !== '0'
        ? <Text style={{ fontSize: 20, fontWeight: '700', color: '#176b87' }}>{t('pos.change')}: {money(sale.preview.change)} TND</Text> : null}
      {sale.approvalNeeded ? (
        <View style={{ gap: 6 }}>
          <Text style={ui.error}>{t('pos.approvalNeeded', { limit: sale.config.cashierMaxDiscountBp / 100 })}</Text>
          <TextInput value={sale.approval.email} onChangeText={(email) => sale.setApproval((a) => ({ ...a, email }))}
            placeholder={t('pos.approverEmail')} style={ui.input} autoCapitalize="none" keyboardType="email-address" />
          <TextInput value={sale.approval.secret} onChangeText={(secret) => sale.setApproval((a) => ({ ...a, secret }))}
            placeholder={t('pos.approverSecret')} style={ui.input} secureTextEntry />
        </View>
      ) : null}
      <Messages error={sale.message} />
      <PrimaryButton label={t('pos.pay')} onPress={() => void sale.pay()} busy={sale.busy} disabled={!canPay} />
      <Pressable onPress={sale.reset}><Text style={ui.link}>{t('pos.cancelSale')}</Text></Pressable>
    </View>
  );
}
