import { router } from 'expo-router';
import { SafeAreaView, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { formatTndMinor } from '../../core/money';
import { useLanguage } from '../../i18n/LanguageProvider';
import { PrimaryButton, SecondaryButton } from '../components';
import { ui } from '../styles';
import type { SaleResult } from './usePosSale';

export function SaleDone({ sale, onNext }: { sale: SaleResult; onNext: () => void }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const money = (v: string) => formatTndMinor(v, language);
  return (
    <SafeAreaView style={ui.safe}><View style={ui.center}>
      <Text style={ui.title}>{t('pos.receiptNo', { n: sale.receiptNumber })}</Text>
      <Text style={{ fontSize: 20 }}>{t('pos.total')}: {money(sale.grossTotal)} TND</Text>
      {sale.change !== '0' ? <Text style={{ fontSize: 28, fontWeight: '700', color: '#176b87' }}>{t('pos.change')}: {money(sale.change)} TND</Text> : null}
      <SecondaryButton label={t('pos.printReceipt')}
        onPress={() => router.push({ pathname: '/documents', params: { kind: 'receipt', id: sale.id, number: sale.receiptNumber } } as never)} />
      <PrimaryButton label={t('pos.nextCustomer')} onPress={onNext} />
    </View></SafeAreaView>
  );
}
