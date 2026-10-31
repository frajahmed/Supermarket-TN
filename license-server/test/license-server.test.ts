/**
 * Ende-zu-Ende-Test des Lizenzservers über HTTP:
 * Kunde anlegen -> neues Gerät fragt an -> Admin schaltet frei -> Gerät erhält Zertifikat
 * -> Kundenserver holt Lizenz -> Sperren wirkt -> Limits und Fälschungen werden abgewiesen.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  generateSigningKeys, loadPrivateKey, loadPublicKey, publicKeyToB64, verifyToken, TokenError,
  type DeviceCertificate, type LicenseToken,
} from '../../shared/license-core.ts';
import { openDatabase } from '../src/db.ts';
import { createLicenseServer } from '../src/http.ts';
import { LicenseService } from '../src/service.ts';

const keys = generateSigningKeys();
const pub = loadPublicKey(keys.publicPem);
let server: Server;
let base = '';
let svc: LicenseService;
let adminToken = '';
let installationId = '';
let installationSecret = '';

async function call(method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as any };
}

function newDevice() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { publicKey: publicKeyToB64(publicKey), privateKey };
}

before(async () => {
  svc = new LicenseService(openDatabase(':memory:'), loadPrivateKey(keys.privatePem));
  await svc.createAdmin('ahmed@example.tn', 'sehr-geheimes-passwort');
  server = createLicenseServer(svc, keys.publicPem).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

test('Admin-Anmeldung: falsches Passwort 401, richtiges liefert Sitzung', async () => {
  assert.equal((await call('POST', '/admin/api/login', { email: 'ahmed@example.tn', password: 'falsch' })).status, 401);
  const ok = await call('POST', '/admin/api/login', { email: 'AHMED@example.tn', password: 'sehr-geheimes-passwort' });
  assert.equal(ok.status, 200);
  adminToken = ok.body.token;
  assert.equal((await call('GET', '/admin/api/licensees')).status, 401, 'ohne Sitzung kein Zugriff');
});

test('Kunde anlegen: Installations-Secret nur einmal sichtbar', async () => {
  const r = await call('POST', '/admin/api/licensees',
    { name: 'Grossiste Sfax', taxId: '1234567A/M/000', maxDevices: 2, paidUntil: '2099-12-31' }, adminToken);
  assert.equal(r.status, 200);
  installationId = r.body.installationId;
  installationSecret = r.body.installationSecret;
  const list = await call('GET', '/admin/api/licensees', undefined, adminToken);
  assert.equal(list.body.length, 1);
  assert.equal(JSON.stringify(list.body).includes(installationSecret), false, 'Secret darf nie wieder ausgeliefert werden');
});

test('Gerät fragt an, Admin schaltet frei, Gerät erhält gültiges Zertifikat', async () => {
  const dev = newDevice();
  const req = await call('POST', '/v1/activation-requests',
    { installationId, name: 'Kasse 1', kind: 'pos', publicKey: dev.publicKey });
  assert.equal(req.status, 200);
  assert.match(req.body.activationCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);

  // erneute Anfrage desselben Geräts -> gleiche Anfrage, kein Duplikat
  const again = await call('POST', '/v1/activation-requests',
    { installationId, name: 'Kasse 1', kind: 'pos', publicKey: dev.publicKey });
  assert.equal(again.body.requestId, req.body.requestId);

  const before = await call('GET', `/v1/activation-requests/${req.body.requestId}`);
  assert.deepEqual(before.body, { status: 'pending' });

  const pending = await call('GET', '/admin/api/devices?status=pending', undefined, adminToken);
  assert.equal(pending.body[0].activationCode, req.body.activationCode, 'Admin sieht denselben Code wie das Gerät');

  assert.equal((await call('POST', `/admin/api/devices/${req.body.requestId}/approve`, {}, adminToken)).status, 200);
  const after = await call('GET', `/v1/activation-requests/${req.body.requestId}`);
  assert.equal(after.body.status, 'approved');

  const cert = verifyToken<DeviceCertificate>(after.body.certificate, pub, 'device');
  assert.equal(cert.inst, installationId);
  assert.equal(cert.dpk, dev.publicKey);
  assert.equal(cert.kind, 'pos');
});

test('Gerätelimit laut Vertrag wird durchgesetzt', async () => {
  const ids: string[] = [];
  for (const name of ['Handy Lager', 'Tablet Chef']) {
    const r = await call('POST', '/v1/activation-requests',
      { installationId, name, kind: 'phone', publicKey: newDevice().publicKey });
    ids.push(r.body.requestId);
  }
  assert.equal((await call('POST', `/admin/api/devices/${ids[0]}/approve`, {}, adminToken)).status, 200);  // 2 von 2
  const third = await call('POST', `/admin/api/devices/${ids[1]}/approve`, {}, adminToken);
  assert.equal(third.status, 409);
  assert.match(third.body.error, /Gerätelimit/);
});

test('Lizenzabgleich: falsches Secret 401, richtiges liefert signierte Lizenz', async () => {
  assert.equal((await call('POST', '/v1/license/check', { installationId }, 'falsch')).status, 401);
  const r = await call('POST', '/v1/license/check', { installationId }, installationSecret);
  assert.equal(r.status, 200);
  const lic = verifyToken<LicenseToken>(r.body.license, pub, 'license');
  assert.equal(lic.mode, 'active');
  assert.equal(lic.maxDevices, 2);
  assert.ok(lic.graceUntil - lic.iat >= 14 * 86400, '14 Tage Offline-Reserve');
  assert.deepEqual(lic.revokedDevices, []);
});

test('Gesperrtes Gerät erscheint in der nächsten Lizenz', async () => {
  const devices = await call('GET', '/admin/api/devices?status=approved', undefined, adminToken);
  const target = devices.body.find((d: any) => d.name === 'Kasse 1');
  assert.equal((await call('POST', `/admin/api/devices/${target.id}/revoke`, {}, adminToken)).status, 200);
  const r = await call('POST', '/v1/license/check', { installationId }, installationSecret);
  const lic = verifyToken<LicenseToken>(r.body.license, pub, 'license');
  assert.deepEqual(lic.revokedDevices, [target.id]);
});

test('Kunde gesperrt: keine neuen Geräte, Lizenz im Nur-Lesen-Modus', async () => {
  await call('PATCH', `/admin/api/licensees/${installationId}`, { status: 'suspended' }, adminToken);
  const req = await call('POST', '/v1/activation-requests',
    { installationId, name: 'Neu', kind: 'phone', publicKey: newDevice().publicKey });
  assert.equal(req.status, 403);
  const r = await call('POST', '/v1/license/check', { installationId }, installationSecret);
  assert.equal(verifyToken<LicenseToken>(r.body.license, pub, 'license').mode, 'read_only');
  await call('PATCH', `/admin/api/licensees/${installationId}`, { status: 'active' }, adminToken);
});

test('Mietlaufzeit: aktiv, 7 Tage Warnung, danach Nur-Lesen', () => {
  const at = (d: string) => Date.parse(d + 'T12:00:00Z') / 1000;
  assert.equal(LicenseService.modeFor('2026-11-30', 'active', at('2026-11-30')), 'active');
  assert.equal(LicenseService.modeFor('2026-11-30', 'active', at('2026-12-07')), 'warning');
  assert.equal(LicenseService.modeFor('2026-11-30', 'active', at('2026-12-08')), 'read_only');
});

test('Gefälschte oder fremde Zertifikate werden erkannt', () => {
  const other = generateSigningKeys();
  // Manipulierter Inhalt (mehr Geräte, aktiv) mit alter Signatur fällt durch …
  const r = svc.checkLicense(installationId, installationSecret);
  const [body] = r.split('.');
  const tampered = `${Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url').toString()), mode: 'active', maxDevices: 999 })).toString('base64url')}.${r.split('.')[1]}`;
  assert.throws(() => verifyToken(tampered, pub, 'license'), TokenError);
  assert.throws(() => verifyToken(r, loadPublicKey(other.publicPem), 'license'), TokenError);
  assert.throws(() => verifyToken(r, pub, 'device'), TokenError, 'Lizenz-Token gilt nicht als Gerätezertifikat');
});

test('Ungültige Eingaben: falscher Schlüssel, Typ, unbekannte Installation', async () => {
  const bad = await call('POST', '/v1/activation-requests', { installationId, name: 'X', kind: 'pos', publicKey: 'abc' });
  assert.equal(bad.status, 400);
  const kind = await call('POST', '/v1/activation-requests', { installationId, name: 'X', kind: 'toaster', publicKey: newDevice().publicKey });
  assert.equal(kind.status, 400);
  const unknown = await call('POST', '/v1/activation-requests',
    { installationId: '00000000-0000-0000-0000-000000000000', name: 'X', kind: 'pos', publicKey: newDevice().publicKey });
  assert.equal(unknown.status, 404);
});
