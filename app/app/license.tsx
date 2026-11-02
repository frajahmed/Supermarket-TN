import { useEffect, useState } from 'react';
import { SafeAreaView, StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { CustomerServerClient } from '../src/api/customer-server';
import { licenseBannerKey, LicenseMode } from '../src/core/license';
import { loadAccessToken, loadServerUrl } from '../src/device/runtime';

export default function LicenseScreen() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<LicenseMode>('unlicensed');
  useEffect(() => {
    void Promise.all([loadServerUrl(), loadAccessToken()]).then(([serverUrl, accessToken]) => {
      if (!serverUrl || !accessToken) return null;
      return new CustomerServerClient(serverUrl).licenseStatus(accessToken);
    }).then((value) => {
      if (!value) return;
      const status = value as { mode?: LicenseMode };
      if (status.mode) setMode(status.mode);
    }).catch(() => undefined);
  }, []);
  return <SafeAreaView style={styles.safe}><View style={styles.banner}><Text>{t(licenseBannerKey(mode))}</Text></View></SafeAreaView>;
}

const styles = StyleSheet.create({ safe: { flex: 1, padding: 24 }, banner: { padding: 16, borderRadius: 8, backgroundColor: '#f3d36b' } });
