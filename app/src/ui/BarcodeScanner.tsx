import { useRef } from 'react';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { normalizeScannedCode, SCAN_TYPES } from '../core/products';
import { ui } from './styles';

// Die Kamera meldet denselben Code mehrmals pro Sekunde – daher 1,5 s Sperre je Code.
export function BarcodeScanner({ onCode, onClose, hint }: {
  onCode: (code: string, type: string) => void; onClose: () => void; hint?: string;
}) {
  const { t } = useTranslation();
  const [permission, requestPermission] = useCameraPermissions();
  const last = useRef<{ code: string; at: number } | null>(null);

  if (!permission) return <ActivityIndicator />;
  if (!permission.granted) {
    return (
      <View style={[ui.card, { gap: 10 }]}>
        <Text>{t('products.cameraNeeded')}</Text>
        <Pressable style={ui.primary} onPress={() => void requestPermission()}><Text style={ui.primaryText}>{t('products.allowCamera')}</Text></Pressable>
        <Pressable onPress={onClose}><Text style={ui.link}>{t('back')}</Text></Pressable>
      </View>
    );
  }
  return (
    <View style={styles.box}>
      <CameraView style={styles.camera} facing="back" barcodeScannerSettings={{ barcodeTypes: [...SCAN_TYPES] }}
        onBarcodeScanned={(s) => {
          const code = normalizeScannedCode(s.data);
          const now = Date.now();
          if (!code || (last.current && last.current.code === code && now - last.current.at < 1500)) return;
          last.current = { code, at: now };
          onCode(code, s.type);
        }} />
      <View style={ui.row}>
        <Text style={[ui.muted, { flex: 1 }]}>{hint ?? t('products.aimCamera')}</Text>
        <Pressable style={ui.secondary} onPress={onClose}><Text style={ui.secondaryText}>{t('orders.closeCamera')}</Text></Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({ box: { gap: 8 }, camera: { height: 220, borderRadius: 10, overflow: 'hidden' } });
