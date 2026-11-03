export type LicenseMode = 'active' | 'warning' | 'read_only' | 'unlicensed';
export type LicenseBannerKey = 'license.active' | 'license.warning' | 'license.readOnly' | 'license.unlicensed';

export function licenseBannerKey(mode: LicenseMode): LicenseBannerKey {
  if (mode === 'active') return 'license.active';
  if (mode === 'warning') return 'license.warning';
  if (mode === 'read_only') return 'license.readOnly';
  return 'license.unlicensed';
}
