import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assignableRoles, canEditUser, canRevoke, groupSecret, isTotpCode, userBody, type UserForm } from '../src/core/users.ts';

const cashier: UserForm = { email: ' Amira@Shop.TN ', displayName: ' Amira ', role: 'cashier', password: '', pin: '4711',
  storeIds: ['s2', 's1'], isActive: true };

test('Rollen: Filialleiter verwaltet nur Lager und Kasse', () => {
  assert.deepEqual(assignableRoles('owner'), ['owner', 'manager', 'stock_clerk', 'cashier']);
  assert.deepEqual(assignableRoles('manager'), ['stock_clerk', 'cashier']);
  assert.deepEqual(assignableRoles('cashier'), []);
  assert.equal(canEditUser('manager', { role: 'manager' }), false);
  assert.equal(canEditUser('manager', { role: 'cashier' }), true);
});

test('Anlegen: Passwort für Inhaber/Filialleiter, PIN oder Passwort für Kasse/Lager, Filiale Pflicht', () => {
  const ok = userBody(cashier, { myRole: 'manager', mode: 'create' });
  assert.ok(ok.ok);
  assert.deepEqual(ok.body, { email: 'amira@shop.tn', displayName: 'Amira', role: 'cashier', storeIds: ['s1', 's2'], pin: '4711' });
  assert.deepEqual(userBody({ ...cashier, role: 'manager', pin: '' }, { myRole: 'owner', mode: 'create' }),
    { ok: false, errors: { password: 'passwordRequired' } });
  assert.deepEqual(userBody({ ...cashier, role: 'manager' }, { myRole: 'manager', mode: 'create' }),
    { ok: false, errors: { role: 'roleNotAllowed', password: 'passwordRequired' } });
  assert.deepEqual(userBody({ ...cashier, pin: '' }, { myRole: 'owner', mode: 'create' }), { ok: false, errors: { pin: 'secretRequired' } });
  assert.deepEqual(userBody({ ...cashier, pin: '12' , password: 'kurz' }, { myRole: 'owner', mode: 'create' }),
    { ok: false, errors: { password: 'passwordTooShort', pin: 'invalidPin' } });
  assert.deepEqual(userBody({ ...cashier, storeIds: [] }, { myRole: 'owner', mode: 'create' }), { ok: false, errors: { storeIds: 'storeRequired' } });
  const owner = userBody({ ...cashier, role: 'owner', password: 'Sehr-geheim-2026', pin: '1234', storeIds: [] }, { myRole: 'owner', mode: 'create' });
  assert.ok(owner.ok && !('pin' in owner.body), 'Inhaber bekommt keine PIN (PIN-Login nur Kasse/Lager)');
});

test('Ändern: nur geänderte Felder; leeres Passwort/PIN bleibt unverändert', () => {
  const initial = { ...cashier, email: 'amira@shop.tn', displayName: 'Amira', pin: '' };
  const same = userBody(initial, { myRole: 'owner', mode: 'edit', initial });
  assert.ok(same.ok);
  assert.deepEqual(same.body, {});
  const changed = userBody({ ...initial, isActive: false, pin: '9876', storeIds: ['s1'] }, { myRole: 'owner', mode: 'edit', initial });
  assert.ok(changed.ok);
  assert.deepEqual(changed.body, { storeIds: ['s1'], pin: '9876', isActive: false });
});

test('2FA und Geräte', () => {
  assert.equal(groupSecret('GEZDGNBVGY3TQOJQ'), 'GEZD GNBV GY3T QOJQ');
  assert.equal(isTotpCode(' 123456 '), true);
  assert.equal(isTotpCode('12345'), false);
  assert.equal(canRevoke({ revokedAt: null, isCurrent: false }), true);
  assert.equal(canRevoke({ revokedAt: null, isCurrent: true }), false, 'eigenes Gerät');
  assert.equal(canRevoke({ revokedAt: '2026-11-05', isCurrent: false }), false);
});
