import { useEffect, useState } from 'react';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, SafeAreaView, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../src/core/api-client';
import {
  changedFields, moneyInputFromMinor, productBodyFromForm, TAX_RATES_BP, trimDecimal, UNITS,
  type ProductDetail, type ProductForm, type ProductFormError,
} from '../../src/core/products';
import { getApi } from '../../src/device/session';
import { ui } from '../../src/ui/styles';
import { LicenseBanner, useProfile } from '../../src/ui/useProfile';

const EMPTY: ProductForm = {
  sku: '', nameFr: '', nameAr: '', nameEn: '', unit: 'piece', salePrice: '', purchasePrice: '',
  taxRateBp: 1900, minStock: '', trackExpiry: true,
};

/** Produkt anlegen (optional mit gescanntem Barcode) oder ändern (T-110). */
export default function ProductEditScreen() {
  const { t } = useTranslation();
  const params = useLocalSearchParams<{ id?: string; barcode?: string; symbology?: string }>();
  const { profile, can, canWrite } = useProfile();
  const [form, setForm] = useState<ProductForm>({ ...EMPTY, sku: params.barcode ?? '' });
  const [initial, setInitial] = useState<ProductForm | null>(null);
  const [loading, setLoading] = useState(Boolean(params.id));
  const [errors, setErrors] = useState<Partial<Record<keyof ProductForm, ProductFormError>>>({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const canEditPrices = can('price.update');
  const showCost = can('report.finance');

  useEffect(() => {
    if (!params.id) return;
    void (async () => {
      try {
        const { product: p } = await (await getApi()).get<ProductDetail>(`/api/v1/products/${params.id}`);
        const loaded: ProductForm = {
          sku: p.sku, nameFr: p.name.fr ?? '', nameAr: p.name.ar ?? '', nameEn: p.name.en ?? '',
          unit: (UNITS as readonly string[]).includes(p.unit) ? p.unit as ProductForm['unit'] : 'piece',
          salePrice: moneyInputFromMinor(p.salePrice), purchasePrice: moneyInputFromMinor(p.purchasePrice ?? null),
          taxRateBp: p.taxRateBp, minStock: trimDecimal(p.minStock), trackExpiry: p.trackExpiry,
        };
        setForm(loaded); setInitial(loaded);
      } catch {
        setMessage(t('products.loadFailed'));
      } finally {
        setLoading(false);
      }
    })();
  }, [params.id, t]);

  const set = <K extends keyof ProductForm>(key: K, value: ProductForm[K]) => setForm((f) => ({ ...f, [key]: value }));

  async function save() {
    // Einkaufspreis nur senden, wenn er auch angezeigt wird (sonst würde ein leeres Feld nichts bedeuten)
    const priced = { canEditPrices };
    const result = productBodyFromForm(showCost ? form : { ...form, purchasePrice: '' }, {
      ...priced, source: params.barcode ? 'barcode' : 'manual' });
    if (!result.ok) { setErrors(result.errors); return; }
    setErrors({}); setMessage(''); setBusy(true);
    try {
      const api = await getApi();
      if (params.id && initial) {
        const before = productBodyFromForm(showCost ? initial : { ...initial, purchasePrice: '' }, priced);
        const { source: _s, ...after } = result.body;
        const patch = before.ok ? changedFields(before.body, after) : after;
        if (Object.keys(patch).length) await api.patch(`/api/v1/products/${params.id}`, patch);
        router.back();
        return;
      }
      const created = await api.post<{ id: string }>('/api/v1/products', result.body);
      if (params.barcode) {
        try {
          await api.post(`/api/v1/products/${created.id}/barcodes`, { code: params.barcode, symbology: params.symbology ?? 'ean13' });
        } catch {
          setMessage(t('products.barcodeConflict'));
        }
      }
      router.replace({ pathname: '/products/[id]', params: { id: created.id } } as never);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) setErrors({ sku: 'skuTaken' });
      else if (e instanceof ApiError && e.status === 403) setMessage(t('products.forbidden'));
      else setMessage(t('products.saveFailed'));
    } finally {
      setBusy(false);
    }
  }

  if (loading || !profile) return <SafeAreaView style={ui.safe}><View style={ui.center}><ActivityIndicator /></View></SafeAreaView>;
  const writable = canWrite('product.write');
  const field = (key: keyof ProductForm, label: string, extra: object = {}) => (
    <View style={{ gap: 4 }}>
      <Text>{label}</Text>
      <TextInput value={String(form[key])} onChangeText={(v) => set(key, v as never)} style={ui.input} editable={writable} {...extra} />
      {errors[key] ? <Text style={ui.error}>{t(`products.errors.${errors[key]}`)}</Text> : null}
    </View>
  );

  return (
    <SafeAreaView style={ui.safe}>
      <ScrollView contentContainerStyle={ui.container} keyboardShouldPersistTaps="handled">
        <Text style={ui.title}>{params.id ? t('products.edit') : t('products.create')}</Text>
        <LicenseBanner profile={profile} />
        {params.barcode ? <Text style={ui.muted}>{t('products.barcode')}: {params.barcode}</Text> : null}
        {field('sku', t('products.sku'), { autoCapitalize: 'characters', autoCorrect: false })}
        {field('nameFr', t('products.nameFr'))}
        {field('nameAr', t('products.nameAr'), { textAlign: 'right' })}
        {field('nameEn', t('products.nameEn'))}

        <Text>{t('products.unit')}</Text>
        <View style={ui.row}>
          {UNITS.map((u) => (
            <Pressable key={u} style={[ui.chip, form.unit === u && ui.chipActive]} onPress={() => writable && set('unit', u)}>
              <Text style={form.unit === u ? ui.chipActiveText : undefined}>{t(`units.${u}`)}</Text>
            </Pressable>
          ))}
        </View>

        {canEditPrices ? field('salePrice', `${t('products.salePrice')} (TND)`, { keyboardType: 'decimal-pad' }) : null}
        {canEditPrices && showCost ? field('purchasePrice', `${t('products.purchasePrice')} (TND)`, { keyboardType: 'decimal-pad' }) : null}

        <Text>{t('products.tax')}</Text>
        <View style={ui.row}>
          {TAX_RATES_BP.map((r) => (
            <Pressable key={r} style={[ui.chip, form.taxRateBp === r && ui.chipActive]} onPress={() => writable && set('taxRateBp', r)}>
              <Text style={form.taxRateBp === r ? ui.chipActiveText : undefined}>{r / 100} %</Text>
            </Pressable>
          ))}
        </View>

        {field('minStock', t('products.minStock'), { keyboardType: 'decimal-pad' })}
        <View style={ui.row}>
          <Switch value={form.trackExpiry} onValueChange={(v) => set('trackExpiry', v)} disabled={!writable} />
          <Text>{t('products.trackExpiry')}</Text>
        </View>

        {message ? <Text style={ui.error} accessibilityRole="alert">{message}</Text> : null}
        <Pressable style={[ui.primary, (!writable || busy) && ui.disabled]} disabled={!writable || busy} onPress={() => void save()}>
          {busy ? <ActivityIndicator color="white" /> : <Text style={ui.primaryText}>{t('products.save')}</Text>}
        </Pressable>
        <Pressable onPress={() => router.back()}><Text style={ui.link}>{t('back')}</Text></Pressable>
      </ScrollView>
    </SafeAreaView>
  );
}
