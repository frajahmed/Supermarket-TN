import { useCallback, useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { SignedOutError } from '../core/api-client';
import { licenseAllowsWrite, licenseBannerColor, type Profile } from '../core/home';
import { licenseBannerKey } from '../core/license';
import { currentStoreId, loadProfile } from '../device/session';

/** Profil, Rechte und Filiale für einen Bildschirm. `canWrite` berücksichtigt den Lizenzstatus. */
export function useProfile() {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [failed, setFailed] = useState(false);
  const reload = useCallback(async (force = false) => {
    setFailed(false);
    try {
      setProfile(await loadProfile(force));
    } catch (e) {
      if (!(e instanceof SignedOutError)) setFailed(true);
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);
  const writable = profile ? licenseAllowsWrite(profile.license.mode) : false;
  return {
    profile, failed, reload, storeId: profile ? currentStoreId() : null,
    can: (permission: string) => Boolean(profile?.permissions.includes(permission)),
    /** Recht vorhanden UND Lizenz erlaubt Schreiben */
    canWrite: (permission: string) => writable && Boolean(profile?.permissions.includes(permission)),
  };
}

/** Lizenzbanner (gelb = Warnung, rot = nur Lesen); bei aktiver Lizenz unsichtbar. */
export function LicenseBanner({ profile }: { profile: Profile | null }) {
  const { t } = useTranslation();
  if (!profile) return null;
  const color = licenseBannerColor(profile.license.mode);
  if (!color) return null;
  return (
    <View style={[styles.banner, { backgroundColor: color.background }]} accessibilityRole="alert">
      <Text style={[styles.title, { color: color.text }]}>{t(licenseBannerKey(profile.license.mode))}</Text>
      {!licenseAllowsWrite(profile.license.mode) ? <Text style={{ color: color.text }}>{t('home.readOnlyHint')}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({ banner: { padding: 12, borderRadius: 8, gap: 4 }, title: { fontWeight: '700' } });
