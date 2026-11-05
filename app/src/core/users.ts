export type Role = 'owner' | 'manager' | 'stock_clerk' | 'cashier';
export const ROLES: readonly Role[] = ['owner', 'manager', 'stock_clerk', 'cashier'];
const PASSWORD_ROLES: readonly Role[] = ['owner', 'manager'];
const PIN_ROLES: readonly Role[] = ['stock_clerk', 'cashier'];

export interface User {
  id: string; email: string; displayName: string; role: Role; locale: string | null; isActive: boolean;
  totpConfigured: boolean; storeIds: string[];
}

/** Filialleiter verwalten nur Lageristen und Kassierer (wie users.service im Backend). */
export function assignableRoles(myRole: Role): Role[] {
  if (myRole === 'owner') return [...ROLES];
  if (myRole === 'manager') return ['stock_clerk', 'cashier'];
  return [];
}

export function canEditUser(myRole: Role, target: Pick<User, 'role'>): boolean {
  return assignableRoles(myRole).includes(target.role);
}

export interface UserForm {
  email: string; displayName: string; role: Role; password: string; pin: string; storeIds: string[]; isActive: boolean;
}

export type UserFormError = 'invalidEmail' | 'nameRequired' | 'roleNotAllowed' | 'passwordTooShort' | 'passwordRequired'
  | 'invalidPin' | 'secretRequired' | 'storeRequired';

/** Leeres Passwort/PIN beim Ändern = unverändert. */
export function userBody(f: UserForm, opts: { myRole: Role; mode: 'create' | 'edit'; initial?: UserForm }):
  { ok: true; body: Record<string, unknown> } | { ok: false; errors: Partial<Record<keyof UserForm, UserFormError>> } {
  const errors: Partial<Record<keyof UserForm, UserFormError>> = {};
  const email = f.email.trim().toLowerCase();
  if (opts.mode === 'create' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) errors.email = 'invalidEmail';
  if (!f.displayName.trim()) errors.displayName = 'nameRequired';
  if (!assignableRoles(opts.myRole).includes(f.role)) errors.role = 'roleNotAllowed';
  if (f.password && f.password.length < 10) errors.password = 'passwordTooShort';
  if (f.pin && !/^\d{4,8}$/u.test(f.pin)) errors.pin = 'invalidPin';
  if (opts.mode === 'create') {
    if (PASSWORD_ROLES.includes(f.role) && !f.password) errors.password = errors.password ?? 'passwordRequired';
    if (PIN_ROLES.includes(f.role) && !f.password && !f.pin) errors.pin = errors.pin ?? 'secretRequired';
  }
  if (f.role !== 'owner' && f.storeIds.length === 0) errors.storeIds = 'storeRequired';
  if (Object.keys(errors).length) return { ok: false, errors };

  const full: Record<string, unknown> = {
    displayName: f.displayName.trim(), role: f.role, storeIds: f.role === 'owner' ? [] : [...f.storeIds].sort(),
  };
  if (f.password) full.password = f.password;
  if (f.pin && PIN_ROLES.includes(f.role)) full.pin = f.pin;
  if (opts.mode === 'create') return { ok: true, body: { email, ...full } };

  const before = opts.initial;
  const patch: Record<string, unknown> = {};
  if (!before || before.displayName.trim() !== full.displayName) patch.displayName = full.displayName;
  if (!before || before.role !== f.role) patch.role = f.role;
  if (!before || JSON.stringify([...before.storeIds].sort()) !== JSON.stringify(full.storeIds)) patch.storeIds = full.storeIds;
  if (full.password) patch.password = full.password;
  if (full.pin) patch.pin = full.pin;
  if (!before || before.isActive !== f.isActive) patch.isActive = f.isActive;
  return { ok: true, body: patch };
}

/** Geheimnis in Vierergruppen für die manuelle Eingabe in der Authenticator-App. */
export function groupSecret(secret: string): string {
  return secret.replace(/\s+/gu, '').replace(/(.{4})(?=.)/gu, '$1 ');
}

export function isTotpCode(code: string): boolean {
  return /^\d{6}$/u.test(code.trim());
}

export interface Device {
  id: string; name: string; kind: string; storeId: string | null; storeName: string | null;
  firstSeenAt: string | null; lastSeenAt: string | null; lastUserName: string | null; revokedAt: string | null; isCurrent: boolean;
}

export function canRevoke(d: Pick<Device, 'revokedAt' | 'isCurrent'>): boolean {
  return !d.revokedAt && !d.isCurrent;
}
