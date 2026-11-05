import { useRef, useState } from 'react';
import { router } from 'expo-router';
import { CameraView, useCameraPermissions, type BarcodeScanningResult } from 'expo-camera';
import { ActivityIndicator, Pressable, SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { ApiError } from '../../src/core/api-client';
import {
  createFromUnknownBarcode, describeScan, normalizeScannedCode, SCAN_TYPES, type BarcodeLookup, type ScanSummary,
} from '../../src/core/products';
import { getApi } from '../../src/device/session';
import { useLanguage } from '../../src/i18n/LanguageProvider';
import { ui } from '../../src/ui/styles';
import { useProfile } from '../../src/ui/useProfile';

type Result = { kind: 'found'; summary: ScanSummary } | { kind: 'unknown'; code: string; type: string } | { kind: 'error' };

export default function ScanScreen() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { canWrite } = useProfile();
  const [permission, requestPermission] = useCameraPermissions();
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const handling = useRef(false);   // Kamera meldet denselben Code mehrfach pro Sekunde

  async function onScanned(scan: BarcodeScanningResult) {
    if (handling.current) return;
    const code = normalizeScannedCode(scan.data);
    if (!code) return;
    handling.current = true;
    setBusy(true);
    try {
      const r = await (await getApi()).get<BarcodeLookup>(`/api/v1/products/by-barcode/${encodeURIComponent(code)}`);
      setResult({ kind: 'found', summary: describeScan(r, language) });
    } catch (e) {
      setResult(e instanceof ApiError && e.status === 404 ? { kind: 'unknown', code, type: scan.type } : { kind: 'error' });
    } finally {
      setBusy(false);
    }
  }

  function again() {
    setResult(null);
    handling.current = false;
  }

  if (!permission) return <SafeAreaView style={ui.safe}><View style={ui.center}><ActivityIndicator /></View></SafeAreaView>;
  if (!permission.granted) {
    return (
      <SafeAreaView style={ui.safe}><View style={ui.center}>
        <Text style={{ textAlign: 'center' }}>{t('products.cameraNeeded')}</Text>
        <Pressable style={ui.primary} onPress={() => void requestPermission()}><Text style={ui.primaryText}>{t('products.allowCamera')}</Text></Pressable>
        <Pressable onPress={() => router.back()}><Text style={ui.link}>{t('back')}</Text></Pressable>
      </View></SafeAreaView>
    );
  }

  return (
    <View style={styles.full}>
      <CameraView style={styles.full} facing="back"
        barcodeScannerSettings={{ barcodeTypes: [...SCAN_TYPES] }}
        onBarcodeScanned={result || busy ? undefined : (s) => void onScanned(s)} />
      <SafeAreaView style={styles.panel}>
        <View style={[ui.card, { gap: 10 }]}>
          {busy ? <ActivityIndicator /> : null}
          {!result && !busy ? <Text style={{ textAlign: 'center' }}>{t('products.aimCamera')}</Text> : null}
          {result?.kind === 'found' ? (
            <>
              <Text style={{ fontWeight: '700', fontSize: 16 }}>{result.summary.label}</Text>
              <Text>{result.summary.packagingLabel
                ? t('products.perScanPackaging', { packaging: result.summary.packagingLabel, qty: result.summary.perScan })
                : t('products.perScan', { qty: result.summary.perScan })}</Text>
              <Pressable style={ui.primary} onPress={() =>
                router.replace({ pathname: '/products/[id]', params: { id: result.summary.productId } } as never)}>
                <Text style={ui.primaryText}>{t('products.openDetail')}</Text>
              </Pressable>
            </>
          ) : null}
          {result?.kind === 'unknown' ? (
            <>
              <Text style={{ fontWeight: '700' }}>{t('products.unknownBarcode', { code: result.code })}</Text>
              {canWrite('product.write') ? (
                <Pressable style={ui.primary} onPress={() =>
                  router.replace({ pathname: '/products/edit', params: createFromUnknownBarcode(result.code, result.type) } as never)}>
                  <Text style={ui.primaryText}>{t('products.createWithBarcode')}</Text>
                </Pressable>
              ) : <Text style={ui.muted}>{t('products.askManager')}</Text>}
            </>
          ) : null}
          {result?.kind === 'error' ? <Text style={ui.error}>{t('errors.serverUnreachable')}</Text> : null}
          <View style={ui.row}>
            {result ? <Pressable style={ui.secondary} onPress={again}><Text style={ui.secondaryText}>{t('products.scanAgain')}</Text></Pressable> : null}
            <Pressable onPress={() => router.back()}><Text style={ui.link}>{t('back')}</Text></Pressable>
          </View>
        </View>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({ full: { flex: 1 }, panel: { position: 'absolute', left: 12, right: 12, bottom: 12 } });
