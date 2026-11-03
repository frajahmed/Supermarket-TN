/**
 * Integrationstest: echte NestJS-App + echte PostgreSQL-DB (Migrationen 001–004)
 * + echter Lizenzserver im selben Prozess.
 *
 * Voraussetzungen (Umgebungsvariablen):
 *   ADMIN_DATABASE_URL  Owner-/Superuser-Verbindung zum Anlegen der Testdaten (Wegwerf-DB!)
 *   DATABASE_URL        Verbindung als app_user (RLS aktiv)
 *
 * Ablauf: Lizenzserver starten -> Kunde + Gerät freischalten -> Installation einrichten ->
 * App starten -> echte Anmeldung mit Gerätezertifikat -> Offline-Push, Rechte, Live-Event, Isolation.
 */
import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Client } from 'pg';
import { io, Socket } from 'socket.io-client';
import {
  generateSigningKeys, hashSecret, loadPrivateKey, publicKeyToB64, signChallenge,
} from '../../../shared/license-core.ts';
import { openDatabase } from '../../../license-server/src/db.ts';
import { createLicenseServer } from '../../../license-server/src/http.ts';
import { LicenseService } from '../../../license-server/src/service.ts';
import { signJwt } from '../core/jwt.ts';
import { generateTotpCode } from '../core/totp.ts';
import { AppModule } from '../app.module';
import { formatAmount, parseAmount, taxFromGross } from '../common/money';

const T_A = randomUUID(), T_B = randomUUID();
const STORE_A1 = randomUUID(), STORE_A2 = randomUUID(), STORE_B = randomUUID();
const OWNER_A = randomUUID(), MANAGER_A = randomUUID(), CLERK_A = randomUUID(), CASHIER_A = randomUUID();
const REMOTE_CLERK_A = randomUUID(), OWNER_B = randomUUID();
const MILK = randomUUID(), FLOUR_B = randomUUID();

let app: INestApplication;
let base = '';
let admin: Client;
let licenseServer: Server;
let storeJwtKey: KeyObject;
let deviceId = '';
let deviceCert = '';
let deviceKey: KeyObject;

/**
 * Access-Token direkt mit dem Schlüssel des Kundenservers ausstellen – nur für Rechte-/Isolationstests.
 * Der echte Anmeldeweg wird im Test „Anmeldung mit freigeschaltetem Gerät" geprüft.
 */
async function token(sub: string, tid: string, role: 'owner' | 'manager' | 'stock_clerk' | 'cashier') {
  return signJwt({ sub, tid, role, did: deviceId }, storeJwtKey, 900);
}

async function api(path: string, tok: string, init: RequestInit = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}

async function post(path: string, body: unknown) {
  const res = await fetch(`${base}/api/v1${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) as any };
}

const mv = (over: Record<string, unknown>) => ({
  clientOpId: randomUUID(), storeId: STORE_A1, productId: MILK,
  occurredAt: new Date().toISOString(), ...over,
});

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'stn-int-'));

  // --- Lizenzserver mit Kunde A und einem freigeschalteten Gerät ---
  const licKeys = generateSigningKeys();
  const licSvc = new LicenseService(openDatabase(':memory:'), loadPrivateKey(licKeys.privatePem));
  const adminId = await licSvc.createAdmin('ahmed@example.tn', 'sehr-geheimes-passwort');
  const inst = licSvc.createLicensee(adminId, { name: 'Kunde A', maxDevices: 5, paidUntil: '2099-12-31' });
  const kp = generateKeyPairSync('ed25519');
  deviceKey = kp.privateKey;
  const req = licSvc.requestActivation({ installationId: inst.installationId, name: 'Kasse 1', kind: 'pos', publicKey: publicKeyToB64(kp.publicKey) });
  deviceId = req.requestId;
  deviceCert = licSvc.approveDevice(adminId, req.requestId);
  licenseServer = createLicenseServer(licSvc, licKeys.publicPem).listen(0, '127.0.0.1');
  await new Promise((r) => licenseServer.once('listening', r));

  writeFileSync(join(dir, 'license.pub'), licKeys.publicPem);
  process.env.LICENSE_PUBLIC_KEY_FILE = join(dir, 'license.pub');
  process.env.LICENSE_SERVER_URL = `http://127.0.0.1:${(licenseServer.address() as AddressInfo).port}`;
  process.env.INSTALLATION_SECRET = inst.installationSecret;
  process.env.STORE_JWT_KEY_FILE = join(dir, 'store-jwt.key');
  process.env.OUTBOX_POLL_MS = '50';

  // --- Datenbank: Mandanten, Benutzer, Installation ---
  admin = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await admin.connect();
  await admin.query(
    `INSERT INTO app.tenants (id, slug, name) VALUES ($1, $3, 'A'), ($2, $4, 'B')`,
    [T_A, T_B, `int-a-${T_A.slice(0, 8)}`, `int-b-${T_B.slice(0, 8)}`]);
  await admin.query(
    `INSERT INTO app.stores (id, tenant_id, code, name) VALUES ($1,$4,'S1','A1'), ($2,$4,'S2','A2'), ($3,$5,'B1','B1')`,
    [STORE_A1, STORE_A2, STORE_B, T_A, T_B]);
  await admin.query(
    `INSERT INTO app.users (id, tenant_id, email, display_name, role, password_hash, pin_hash) VALUES
       ($1,$7,'owner@a.tn','O','owner',$9,NULL), ($2,$7,'clerk@a.tn','C','stock_clerk',NULL,NULL),
       ($3,$7,'cash@a.tn','K','cashier',NULL,$10), ($4,$7,'manager@a.tn','M','manager',NULL,NULL),
       ($5,$7,'remote-clerk@a.tn','R','stock_clerk',NULL,NULL),
       ($6,$8,'owner@b.tn','OB','owner',NULL,NULL)`,
    [OWNER_A, CLERK_A, CASHIER_A, MANAGER_A, REMOTE_CLERK_A, OWNER_B, T_A, T_B,
     await hashSecret('Chef-Passwort-2026'), await hashSecret('4711')]);
  await admin.query(
    `INSERT INTO app.user_store_access (tenant_id, user_id, store_id) VALUES
       ($1,$2,$5), ($1,$3,$5), ($1,$4,$5), ($1,$6,$7)`,
    [T_A, CLERK_A, CASHIER_A, MANAGER_A, STORE_A1, REMOTE_CLERK_A, STORE_A2]);
  await admin.query(
    `INSERT INTO app.products (id, tenant_id, sku, name, sale_price, min_stock) VALUES
       ($1,$3,'LAIT','{"fr":"Lait 1 L","ar":"حليب 1 لتر"}',1350,10), ($2,$4,'FARINE','{"fr":"Farine"}',900,5)`,
    [MILK, FLOUR_B, T_A, T_B]);
  await admin.query('SELECT auth.setup_installation($1, $2)', [inst.installationId, T_A]);

  app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
  storeJwtKey = createPrivateKey(readFileSync(process.env.STORE_JWT_KEY_FILE, 'utf8'));
});

after(async () => {
  await app?.close();
  licenseServer?.close();
  // Testdaten bleiben im Journal (append-only) – Test läuft gegen eine Wegwerf-DB.
  await admin?.end();
});

test('Anmeldung mit freigeschaltetem Gerät: Passwort, PIN, Refresh', async () => {
  const proof = async () => {
    const { body } = await post('/auth/challenge', {});
    return { certificate: deviceCert, challenge: body.challenge, signature: signChallenge(body.challenge, deviceKey) };
  };
  const owner = await post('/auth/login', { email: 'owner@a.tn', password: 'Chef-Passwort-2026', device: await proof() });
  assert.equal(owner.status, 200);
  assert.equal(owner.body.user.role, 'owner');
  assert.equal(owner.body.license.mode, 'active');

  const wrong = await post('/auth/login', { email: 'owner@a.tn', password: 'falsch', device: await proof() });
  assert.equal(wrong.status, 401);

  const cashier = await post('/auth/login', { email: 'cash@a.tn', pin: '4711', device: await proof() });
  assert.equal(cashier.status, 200);
  const alerts = await api(`/stores/${STORE_A1}/stock-alerts`, cashier.body.accessToken);
  assert.equal(alerts.status, 403, 'Kassierer ohne Recht report.stock');

  const refreshed = await post('/auth/refresh', { refreshToken: owner.body.refreshToken });
  assert.equal(refreshed.status, 200);
  const reuse = await post('/auth/refresh', { refreshToken: owner.body.refreshToken });
  assert.equal(reuse.status, 401, 'wiederverwendetes Refresh-Token');

  const lic = await api('/license/status', refreshed.body.accessToken);
  assert.equal(lic.body.mode, 'active');
});

test('Geldbeträge: TND mit 3 Nachkommastellen', () => {
  assert.equal(parseAmount('1,350', 'TND'), 1350n);
  assert.equal(parseAmount('12.5', 'TND'), 12500n);
  assert.throws(() => parseAmount('1.2345', 'TND'));
  assert.equal(taxFromGross(11900n, 1900), 1900n);           // 11,900 TND brutto -> 1,900 TVA
  assert.match(formatAmount(1350n, 'TND', 'fr-TN'), /1,350/);
});

test('ohne Token: 401', async () => {
  const res = await fetch(`${base}/api/v1/sync/pull?storeId=${STORE_A1}`);
  assert.equal(res.status, 401);
});

test('T-103: Setup-Info ist öffentlich und enthält keine Geheimnisse', async () => {
  const res = await fetch(`${base}/api/v1/setup/info`);
  assert.equal(res.status, 200);
  const body = await res.json() as { installationId: string; licenseServerUrl: string; [key: string]: unknown };
  assert.equal(body.installationId, (await admin.query<{ installation_id: string }>(
    'SELECT installation_id FROM app.installation')).rows[0].installation_id);
  assert.equal(body.licenseServerUrl.startsWith('http://127.0.0.1:'), true);
  assert.equal(Object.hasOwn(body, 'installationSecret'), false);
});

test('Offline-Stapel: Annahme, Duplikat, Ablehnung – und Live-Event per WebSocket', async () => {
  const clerk = await token(CLERK_A, T_A, 'stock_clerk');

  // Live-Verbindung des Inhabers (sieht alle Filialen des Mandanten)
  const socket: Socket = io(`${base}/live`, { auth: { token: await token(OWNER_A, T_A, 'owner') }, transports: ['websocket'] });
  const received = new Promise<any>((resolve, reject) => {
    socket.on('stock.changed', resolve);
    setTimeout(() => reject(new Error('kein Live-Event erhalten')), 5000);
  });
  await new Promise<void>((r) => socket.on('connect', () => r()));

  const receipt = mv({ type: 'purchase_receipt', quantityDelta: '24' });
  const res = await api('/sync/push', clerk, {
    method: 'POST',
    body: JSON.stringify({ movements: [
      receipt,
      receipt,                                                      // doppelt gesendet (Offline-Retry)
      mv({ type: 'loss', quantityDelta: '-2' }),                     // ohne Begründung
      mv({ type: 'purchase_receipt', quantityDelta: '5', storeId: STORE_A2 }), // fremde Filiale
      mv({ type: 'loss', quantityDelta: '-1.5', reason: 'Bruch' }),
    ] }),
  });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.results.map((r: any) => r.status),
    ['accepted', 'duplicate', 'rejected', 'rejected', 'accepted']);

  const event = await received;
  assert.equal(event.storeId, STORE_A1);
  assert.equal(event.productId, MILK);
  socket.close();

  const pull = await api(`/sync/pull?storeId=${STORE_A1}&since=0`, clerk);
  assert.equal(pull.status, 200);
  assert.equal(pull.body.movements.length, 2);
  assert.equal(Number(pull.body.stock[0].quantity), 22.5);
});

test('Kassierer darf keinen Wareneingang buchen, aber verkaufen', async () => {
  const cashier = await token(CASHIER_A, T_A, 'cashier');
  const res = await api('/sync/push', cashier, {
    method: 'POST',
    body: JSON.stringify({ movements: [
      mv({ type: 'purchase_receipt', quantityDelta: '100' }),
      mv({ type: 'sale', quantityDelta: '-1' }),
    ] }),
  });
  assert.deepEqual(res.body.results.map((r: any) => r.status), ['rejected', 'accepted']);
});

test('Kassierer hat kein Recht auf Bestandswarnungen (403)', async () => {
  const res = await api(`/stores/${STORE_A1}/stock-alerts`, await token(CASHIER_A, T_A, 'cashier'));
  assert.equal(res.status, 403);
});

test('Mandant B sieht nichts von Mandant A', async () => {
  const ownerB = await token(OWNER_B, T_B, 'owner');
  const pull = await api(`/sync/pull?storeId=${STORE_A1}&since=0`, ownerB);
  assert.equal(pull.status, 200);
  assert.equal(pull.body.movements.length, 0);
  // Schreibversuch in Filiale von A mit Produkt von A
  const push = await api('/sync/push', ownerB, {
    method: 'POST', body: JSON.stringify({ movements: [mv({ type: 'purchase_receipt', quantityDelta: '1' })] }),
  });
  assert.equal(push.body.results[0].status, 'rejected');
});

test('Token mit fremdem Schlüssel wird abgewiesen', async () => {
  const foreign = generateKeyPairSync('ed25519').privateKey;
  const forged = signJwt({ sub: OWNER_B, tid: T_A, role: 'owner', did: deviceId }, foreign, 300);
  const res = await api(`/sync/pull?storeId=${STORE_A1}`, forged);
  assert.equal(res.status, 401);
});

test('Dashboard: Warnung, sobald Mindestbestand unterschritten wird', async () => {
  const owner = await token(OWNER_A, T_A, 'owner');
  const before = await api(`/stores/${STORE_A1}/stock-alerts`, owner);
  assert.equal(before.body.lowStock.length, 0);                       // 21,5 >= 10
  await api('/sync/push', owner, {
    method: 'POST',
    body: JSON.stringify({ movements: [mv({ type: 'loss', quantityDelta: '-15', reason: 'MHD abgelaufen' })] }),
  });
  const afterLoss = await api(`/stores/${STORE_A1}/stock-alerts`, owner);
  assert.equal(afterLoss.body.lowStock.length, 1);                    // 6,5 < 10
  assert.equal(afterLoss.body.lowStock[0].name, 'Lait 1 L');
});

test('Produkt-API: Suche, Barcode/Gebinde, Preisrecht und Mandantentrennung', async () => {
  const owner = await token(OWNER_A, T_A, 'owner');
  const sku = `API-${randomUUID().slice(0, 8)}`;
  const created = await api('/products', owner, {
    method: 'POST',
    body: JSON.stringify({
      sku,
      name: { fr: 'Carton de lait', ar: 'كرتونة حليب' },
      purchasePrice: '900',
      salePrice: '1350',
    }),
  });
  assert.equal(created.status, 201);
  const productId = created.body.id as string;

  const barcode = 'API-UPC-001';
  const addedBarcode = await api(`/products/${productId}/barcodes`, owner, {
    method: 'POST', body: JSON.stringify({ code: barcode, packQty: '1.000' }),
  });
  assert.equal(addedBarcode.status, 201);

  const gtin = 'API-GTIN-012';
  const packaging = await api(`/products/${productId}/packagings`, owner, {
    method: 'POST',
    body: JSON.stringify({ code: 'carton', name: { fr: 'Carton de 12' }, factor: '12.000', gtin }),
  });
  assert.equal(packaging.status, 201);

  const scan = await api(`/products/by-barcode/${gtin}`, owner);
  assert.equal(scan.status, 200);
  assert.equal(scan.body.product.id, productId);
  assert.equal(scan.body.quantityPerScan, '12.000');
  assert.equal(scan.body.packaging.factor, '12.000');

  const duplicate = await api(`/products/${productId}/barcodes`, owner, {
    method: 'POST', body: JSON.stringify({ code: gtin }),
  });
  assert.equal(duplicate.status, 409);
  assert.match(String(duplicate.body.message), /Barcode/);

  const updated = await api(`/products/${productId}`, owner, {
    method: 'PATCH', body: JSON.stringify({ salePrice: '1450' }),
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.salePrice, '1450');
  const audit = await admin.query<{ action: string; before: { salePrice: string }; after: { salePrice: string } }>(
    `SELECT action, before, after FROM app.audit_log WHERE entity_id = $1 ORDER BY id DESC LIMIT 1`,
    [productId],
  );
  assert.equal(audit.rows[0].action, 'price.update');
  assert.equal(audit.rows[0].before.salePrice, '1350');
  assert.equal(audit.rows[0].after.salePrice, '1450');

  const clerk = await token(CLERK_A, T_A, 'stock_clerk');
  const clerkPrice = await api(`/products/${productId}`, clerk, {
    method: 'PATCH', body: JSON.stringify({ salePrice: '1500' }),
  });
  assert.equal(clerkPrice.status, 403);
  const clerkCreatePrice = await api('/products', clerk, {
    method: 'POST',
    body: JSON.stringify({ sku: 'CLERK-PRICE-001', name: { fr: 'Preis nicht erlaubt' }, salePrice: '1500' }),
  });
  assert.equal(clerkCreatePrice.status, 403);

  const cashier = await token(CASHIER_A, T_A, 'cashier');
  const search = await api(`/products?q=${encodeURIComponent('Carton')}`, cashier);
  assert.equal(search.status, 200);
  assert.ok(search.body.items.some((item: { id: string }) => item.id === productId));
  const cashierCreate = await api('/products', cashier, {
    method: 'POST', body: JSON.stringify({ sku: 'CASHIER-001', name: { fr: 'Nicht erlaubt' } }),
  });
  assert.equal(cashierCreate.status, 403);

  const ownerB = await token(OWNER_B, T_B, 'owner');
  const foreignScan = await api(`/products/by-barcode/${gtin}`, ownerB);
  assert.equal(foreignScan.status, 404);

  const removed = await api(`/products/${productId}/barcodes/${barcode}`, owner, { method: 'DELETE' });
  assert.equal(removed.status, 200);
});

test('Produktnamen brauchen mindestens eine unterstützte Sprache', async () => {
  const owner = await token(OWNER_A, T_A, 'owner');
  const invalid = await api('/products', owner, {
    method: 'POST', body: JSON.stringify({ sku: 'INVALID-NAME', name: {} }),
  });
  assert.equal(invalid.status, 400);
});

test('T-107: Einkaufspreise, Literalsuche, Gebinde-Konflikt und Erstellungs-Audit', async () => {
  const owner = await token(OWNER_A, T_A, 'owner');
  const suffix = randomUUID().slice(0, 8);
  const roleProduct = await api('/products', owner, {
    method: 'POST',
    body: JSON.stringify({
      sku: `ROLE-${suffix}`,
      name: { fr: '50% Rabatt', en: '50% discount' },
      purchasePrice: '500',
      salePrice: '900',
    }),
  });
  assert.equal(roleProduct.status, 201);
  assert.equal(roleProduct.body.purchasePrice, '500');
  const roleProductId = roleProduct.body.id as string;

  const createAudit = await admin.query<{ before: unknown; after: { salePrice: string } }>(
    `SELECT before, after FROM app.audit_log
      WHERE entity_id = $1 AND action = 'price.update' ORDER BY id DESC LIMIT 1`,
    [roleProductId],
  );
  assert.equal(createAudit.rows[0].before, null);
  assert.equal(createAudit.rows[0].after.salePrice, '900');

  const otherProduct = await api('/products', owner, {
    method: 'POST',
    body: JSON.stringify({ sku: `OTHER-${suffix}`, name: { fr: '50X Rabatt' } }),
  });
  assert.equal(otherProduct.status, 201);

  const roleBarcode = `ROLE-BARCODE-${suffix}`;
  const addedBarcode = await api(`/products/${roleProductId}/barcodes`, owner, {
    method: 'POST', body: JSON.stringify({ code: roleBarcode }),
  });
  assert.equal(addedBarcode.status, 201);

  const firstPackaging = await api(`/products/${roleProductId}/packagings`, owner, {
    method: 'POST',
    body: JSON.stringify({
      code: 'karton', name: { fr: 'Carton' }, factor: '6.000', gtin: `GTIN-${suffix}`,
    }),
  });
  assert.equal(firstPackaging.status, 201);
  const duplicatePackaging = await api(`/products/${roleProductId}/packagings`, owner, {
    method: 'POST',
    body: JSON.stringify({
      code: 'karton', name: { fr: 'Carton erneut' }, factor: '12.000', gtin: `GTIN-OTHER-${suffix}`,
    }),
  });
  assert.equal(duplicatePackaging.status, 409);
  assert.match(String(duplicatePackaging.body.message), /^Gebinde-Code/);

  const ownerList = await api(`/products?q=${encodeURIComponent('50%')}`, owner);
  assert.equal(ownerList.status, 200);
  assert.deepEqual(ownerList.body.items.map((item: { id: string }) => item.id), [roleProductId]);
  assert.equal(Object.hasOwn(ownerList.body.items[0], 'purchasePrice'), true);

  const manager = await token(MANAGER_A, T_A, 'manager');
  const managerList = await api(`/products?q=${encodeURIComponent(`ROLE-${suffix}`)}`, manager);
  assert.equal(managerList.status, 200);
  assert.equal(Object.hasOwn(managerList.body.items[0], 'purchasePrice'), true);

  const clerk = await token(CLERK_A, T_A, 'stock_clerk');
  const cashier = await token(CASHIER_A, T_A, 'cashier');
  for (const [label, tok] of [['Lagerist', clerk], ['Kassierer', cashier]] as const) {
    const list = await api(`/products?q=${encodeURIComponent(`ROLE-${suffix}`)}`, tok);
    assert.equal(list.status, 200, `${label} darf Produkte suchen`);
    assert.equal(Object.hasOwn(list.body.items[0], 'purchasePrice'), false, `${label} sieht keinen Einkaufspreis`);
  }

  for (const [label, tok, visible] of [
    ['Inhaber', owner, true], ['Filialleiter', manager, true],
    ['Lagerist', clerk, false], ['Kassierer', cashier, false],
  ] as const) {
    const scan = await api(`/products/by-barcode/${roleBarcode}`, tok);
    assert.equal(scan.status, 200, `${label} darf Barcode scannen`);
    assert.equal(Object.hasOwn(scan.body.product, 'purchasePrice'), visible, `${label} Einkaufspreis-Sichtbarkeit`);
  }

  const clerkUpdate = await api(`/products/${roleProductId}`, clerk, {
    method: 'PATCH', body: JSON.stringify({ name: { fr: '50% Rabatt Lager' } }),
  });
  assert.equal(clerkUpdate.status, 200);
  assert.equal(Object.hasOwn(clerkUpdate.body, 'purchasePrice'), false);
});

test('T-102: Benutzerverwaltung, Filialgrenze, TOTP und deaktivierter Refresh', async () => {
  const noToken = await fetch(`${base}/api/v1/users`);
  assert.equal(noToken.status, 401);

  const owner = await token(OWNER_A, T_A, 'owner');
  const cashier = await token(CASHIER_A, T_A, 'cashier');
  const forbidden = await api('/users', cashier);
  assert.equal(forbidden.status, 403);

  const listed = await api('/users', owner);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.items.some((item: { id: string }) => item.id === OWNER_A));
  assert.equal(Object.hasOwn(listed.body.items[0], 'passwordHash'), false);
  assert.equal(Object.hasOwn(listed.body.items[0], 'totpSecretEnc'), false);

  const created = await api('/users', owner, {
    method: 'POST',
    body: JSON.stringify({
      email: `manager-${randomUUID()}@a.tn`, displayName: 'Neuer Filialleiter', role: 'manager',
      password: 'Neues-Passwort-2026', storeIds: [STORE_A1],
    }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.totpConfigured, false, '2FA richtet der Nutzer selbst ein (T-108)');

  const manager = await token(MANAGER_A, T_A, 'manager');
  const managerOwner = await api('/users', manager, {
    method: 'POST',
    body: JSON.stringify({
      email: `owner-${randomUUID()}@a.tn`, displayName: 'Nicht erlaubt', role: 'owner',
      password: 'Neues-Passwort-2026', storeIds: [STORE_A1],
    }),
  });
  assert.equal(managerOwner.status, 403);

  const foreignPatch = await api(`/users/${REMOTE_CLERK_A}`, manager, {
    method: 'PATCH', body: JSON.stringify({ displayName: 'Nicht fremd ändern' }),
  });
  assert.equal(foreignPatch.status, 403);

  const ownBranch = await api('/users', manager, {
    method: 'POST',
    body: JSON.stringify({
      email: `cashier-${randomUUID()}@a.tn`, displayName: 'Neue Kasse', role: 'cashier',
      pin: '1234', storeIds: [STORE_A1],
    }),
  });
  assert.equal(ownBranch.status, 201);

  const proof = async () => {
    const challenge = await post('/auth/challenge', {});
    return { certificate: deviceCert, challenge: challenge.body.challenge, signature: signChallenge(challenge.body.challenge, deviceKey) };
  };
  const login = await post('/auth/login', { email: 'cash@a.tn', pin: '4711', device: await proof() });
  assert.equal(login.status, 200);
  const disabled = await api(`/users/${CASHIER_A}`, owner, {
    method: 'PATCH', body: JSON.stringify({ isActive: false }),
  });
  assert.equal(disabled.status, 200);
  const refresh = await post('/auth/refresh', { refreshToken: login.body.refreshToken });
  assert.equal(refresh.status, 401);
});

test('T-108: 2FA-Selbsteinrichtung, Fehlversuche, letzter Inhaber, gemischte Filialen', async () => {
  const owner = await token(OWNER_A, T_A, 'owner');
  const proof = async () => {
    const challenge = await post('/auth/challenge', {});
    return { certificate: deviceCert, challenge: challenge.body.challenge, signature: signChallenge(challenge.body.challenge, deviceKey) };
  };

  // Kriterium 3: Geheimnis kann nicht mehr vom Ersteller gesetzt werden
  const withSecret = await api('/users', owner, {
    method: 'POST',
    body: JSON.stringify({ email: `x-${randomUUID()}@a.tn`, displayName: 'X', role: 'manager',
      password: 'Neues-Passwort-2026', storeIds: [STORE_A1], totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }),
  });
  assert.equal(withSecret.status, 400);

  const email = `m2fa-${randomUUID()}@a.tn`;
  const created = await api('/users', owner, {
    method: 'POST',
    body: JSON.stringify({ email, displayName: 'Filialleiter 2FA', role: 'manager', password: 'M2fa-Passwort-2026', storeIds: [STORE_A1] }),
  });
  assert.equal(created.status, 201);
  const managerId = created.body.id as string;
  const patchSecret = await api(`/users/${managerId}`, owner, {
    method: 'PATCH', body: JSON.stringify({ totpSecret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' }),
  });
  assert.equal(patchSecret.status, 400, 'Setzen per PATCH verboten, nur Zurücksetzen (null)');

  // Kriterium 2: Setup -> noch kein Code nötig -> falscher Code scheitert -> richtiger Code aktiviert
  const me = await token(managerId, T_A, 'manager');
  const setup = await api('/me/2fa/setup', me, { method: 'POST' });
  assert.equal(setup.status, 200);
  assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
  assert.match(setup.body.otpauthUri, /^otpauth:\/\/totp\//);
  const pendingLogin = await post('/auth/login', { email, password: 'M2fa-Passwort-2026', device: await proof() });
  assert.equal(pendingLogin.status, 200, 'ausstehende Einrichtung verlangt noch keinen Code');

  const now = Math.floor(Date.now() / 1000);
  const good = generateTotpCode(setup.body.secret, now);
  const bad = good === '000000' ? '111111' : '000000';
  assert.equal((await api('/me/2fa/confirm', me, { method: 'POST', body: JSON.stringify({ code: bad }) })).status, 400);
  const confirmed = await api('/me/2fa/confirm', me, { method: 'POST', body: JSON.stringify({ code: good }) });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.totpConfigured, true);

  const noCode = await post('/auth/login', { email, password: 'M2fa-Passwort-2026', device: await proof() });
  assert.equal(noCode.status, 401);
  assert.match(String(noCode.body.message), /TOTP-Code erforderlich/);
  const withCode = await post('/auth/login', {
    email, password: 'M2fa-Passwort-2026', totp: generateTotpCode(setup.body.secret, now + 30), device: await proof(),
  });
  assert.equal(withCode.status, 200);

  const cashierSetup = await api('/me/2fa/setup', await token(CLERK_A, T_A, 'stock_clerk'), { method: 'POST' });
  assert.equal(cashierSetup.status, 403);

  // Kriterium 1 über HTTP: 5 falsche Codes -> gesperrt, auch mit richtigem Code
  for (let i = 0; i < 5; i++) {
    const r = await post('/auth/login', { email, password: 'M2fa-Passwort-2026', totp: bad, device: await proof() });
    assert.equal(r.status, 401);
  }
  const locked = await post('/auth/login', {
    email, password: 'M2fa-Passwort-2026', totp: generateTotpCode(setup.body.secret, now + 60), device: await proof(),
  });
  assert.equal(locked.status, 423);

  // Inhaber setzt 2FA zurück
  const reset = await api(`/users/${managerId}`, owner, { method: 'PATCH', body: JSON.stringify({ totpSecret: null }) });
  assert.equal(reset.status, 200);
  assert.equal(reset.body.totpConfigured, false);

  // Kriterium 4: letzter Inhaber
  const selfDeactivate = await api(`/users/${OWNER_A}`, owner, { method: 'PATCH', body: JSON.stringify({ isActive: false }) });
  assert.equal(selfDeactivate.status, 409);
  const selfDemote = await api(`/users/${OWNER_A}`, owner, { method: 'PATCH', body: JSON.stringify({ role: 'manager' }) });
  assert.equal(selfDemote.status, 409);
  const second = await api('/users', owner, {
    method: 'POST',
    body: JSON.stringify({ email: `owner2-${randomUUID()}@a.tn`, displayName: 'Zweiter Inhaber', role: 'owner', password: 'Owner2-Passwort-2026' }),
  });
  assert.equal(second.status, 201);
  const deactivateSecond = await api(`/users/${second.body.id}`, owner, { method: 'PATCH', body: JSON.stringify({ isActive: false }) });
  assert.equal(deactivateSecond.status, 200, 'mit zweitem aktivem Inhaber erlaubt');

  // Kriterium 5: gemischter Lagerist (Filiale A1 des Filialleiters + fremde Filiale A2)
  const mixed = await api('/users', owner, {
    method: 'POST',
    body: JSON.stringify({ email: `mixed-${randomUUID()}@a.tn`, displayName: 'Gemischt', role: 'stock_clerk', pin: '2468', storeIds: [STORE_A1, STORE_A2] }),
  });
  assert.equal(mixed.status, 201);
  const manager = await token(MANAGER_A, T_A, 'manager');
  const rename = await api(`/users/${mixed.body.id}`, manager, { method: 'PATCH', body: JSON.stringify({ displayName: 'Gemischt 2' }) });
  assert.equal(rename.status, 200, 'Filialleiter darf gemischten Nutzer bearbeiten');
  assert.deepEqual(rename.body.storeIds, [STORE_A1], 'fremde Filiale bleibt für den Filialleiter unsichtbar');
  const deactivateMixed = await api(`/users/${mixed.body.id}`, manager, { method: 'PATCH', body: JSON.stringify({ isActive: false }) });
  assert.equal(deactivateMixed.status, 403);
  const removeOwn = await api(`/users/${mixed.body.id}`, manager, { method: 'PATCH', body: JSON.stringify({ storeIds: [] }) });
  assert.equal(removeOwn.status, 200);
  const afterRemove = await admin.query<{ store_id: string }>(
    'SELECT store_id FROM app.user_store_access WHERE user_id = $1', [mixed.body.id]);
  assert.deepEqual(afterRemove.rows.map((r) => r.store_id), [STORE_A2], 'fremde Filiale bleibt erhalten');
});

test('T-105: Auftrag -> Kreditlimit bei Bestätigung -> Teillieferung -> Rechnung -> Dokument -> Gutschrift', async () => {
  const CUSTOMER = randomUUID();
  await admin.query(
    `INSERT INTO app.customers (id, tenant_id, number, name, tax_id, payment_terms_days, credit_limit, preferred_locale)
     VALUES ($1, $2, $3, 'Épicerie Test', '3333333C/A/000', 30, 10000, 'fr-TN')`,
    [CUSTOMER, T_A, `K-${CUSTOMER.slice(0, 8)}`]);
  const owner = await token(OWNER_A, T_A, 'owner');
  const manager = await token(MANAGER_A, T_A, 'manager');
  const clerk = await token(CLERK_A, T_A, 'stock_clerk');
  const cashier = await token(CASHIER_A, T_A, 'cashier');

  const orderBody = { storeId: STORE_A1, customerId: CUSTOMER, lines: [{ productId: MILK, quantity: '10' }], clientOpId: randomUUID() };
  assert.equal((await api('/sales-orders', cashier, { method: 'POST', body: JSON.stringify(orderBody) })).status, 403);
  const order = await api('/sales-orders', clerk, { method: 'POST', body: JSON.stringify(orderBody) });
  assert.equal(order.status, 201);
  assert.match(order.body.number, /^SO-\d{4}-\d{6}$/);
  const again = await api('/sales-orders', clerk, { method: 'POST', body: JSON.stringify(orderBody) });
  assert.equal(again.body.id, order.body.id, 'doppelt gesendeter Auftrag = ein Auftrag');
  // 10 × 1,350 = 13,500 + 19 % 2,565 + Timbre 1,000 = 17,065 > Limit 10,000
  assert.equal(order.body.estimatedGross, '17065');

  // Kriterium 1: Kreditlimit blockiert die Bestätigung
  const blocked = await api(`/sales-orders/${order.body.id}/confirm`, clerk, { method: 'POST', body: '{}' });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'CREDIT_LIMIT');
  const managerOverride = await api(`/sales-orders/${order.body.id}/confirm`, manager, {
    method: 'POST', body: JSON.stringify({ overrideReason: 'Stammkunde' }) });
  assert.equal(managerOverride.status, 403, 'nur der Inhaber darf übersteuern');
  const ownerOverride = await api(`/sales-orders/${order.body.id}/confirm`, owner, {
    method: 'POST', body: JSON.stringify({ overrideReason: 'Zahlung zugesagt' }) });
  assert.equal(ownerOverride.status, 200);
  assert.equal(ownerOverride.body.status, 'confirmed');
  const audit = await admin.query(`SELECT after FROM app.audit_log WHERE action = 'credit.override' AND entity_id = $1`, [order.body.id]);
  assert.equal(audit.rows[0].after.reason, 'Zahlung zugesagt');

  // Teillieferung 4 von 10
  const lineId = ownerOverride.body.lines[0].id as string;
  const deliveryBody = { clientOpId: randomUUID(), lines: [{ orderLineId: lineId, quantity: '4' }] };
  const delivery = await api(`/sales-orders/${order.body.id}/deliveries`, clerk, { method: 'POST', body: JSON.stringify(deliveryBody) });
  assert.equal(delivery.status, 201);
  assert.match(delivery.body.number, /^BL-\d{4}-\d{6}$/);
  const replay = await api(`/sales-orders/${order.body.id}/deliveries`, clerk, { method: 'POST', body: JSON.stringify(deliveryBody) });
  assert.equal(replay.body.id, delivery.body.id, 'erneut gesendete Lieferung bucht nicht doppelt');
  const over = await api(`/sales-orders/${order.body.id}/deliveries`, clerk, {
    method: 'POST', body: JSON.stringify({ clientOpId: randomUUID(), lines: [{ orderLineId: lineId, quantity: '7' }] }) });
  assert.equal(over.status, 422);
  const moves = await admin.query(`SELECT sum(quantity_delta)::text AS q FROM app.stock_movements WHERE ref_type = 'sales_order' AND ref_id = $1`, [order.body.id]);
  assert.equal(moves.rows[0].q, '-4.000', 'Lager um genau 4 reduziert');

  // Kriterium 2: Rechnung nur über die gelieferte Menge
  assert.equal((await api(`/deliveries/${delivery.body.id}/invoice`, clerk, { method: 'POST' })).status, 403);
  const invoice = await api(`/deliveries/${delivery.body.id}/invoice`, manager, { method: 'POST' });
  assert.equal(invoice.status, 201);
  // 4 × 1,350 = 5,400 + 19 % 1,026 + Timbre 1,000 = 7,426
  assert.deepEqual([invoice.body.netTotal, invoice.body.taxTotal, invoice.body.stampDuty, invoice.body.grossTotal],
    ['5400', '1026', '1000', '7426']);

  // Kriterium 3: Summen im Dokument = Summen in sales_invoices (Kassierer darf drucken)
  const docRes = await fetch(`${base}/api/v1/invoices/${invoice.body.id}/document`, { headers: { authorization: `Bearer ${cashier}` } });
  assert.equal(docRes.status, 200);
  assert.match(docRes.headers.get('content-type') ?? '', /text\/html/);
  const html = await docRes.text();
  const db = (await admin.query(
    `SELECT net_total::text AS net, tax_total::text AS tax, stamp_duty::text AS stamp, gross_total::text AS gross, number
       FROM app.sales_invoices WHERE id = $1`, [invoice.body.id])).rows[0];
  const attr = (name: string) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1];
  assert.deepEqual([attr('data-total-net'), attr('data-total-tax'), attr('data-total-stamp'), attr('data-total-gross')],
    [db.net, db.tax, db.stamp, db.gross]);
  assert.ok(html.includes(db.number) && html.includes('فاتورة') && html.includes('3333333C/A/000'));

  const delDoc = await fetch(`${base}/api/v1/deliveries/${delivery.body.id}/document`, { headers: { authorization: `Bearer ${clerk}` } });
  const delHtml = await delDoc.text();
  assert.equal(delDoc.status, 200);
  assert.ok(delHtml.includes('Bon de livraison') && delHtml.includes(delivery.body.number));
  assert.equal(delHtml.includes('data-total-gross'), false, 'Lieferschein ohne Preise');

  // Gutschrift mit Bezug
  const credit = await api(`/invoices/${invoice.body.id}/credit-note`, manager, { method: 'POST', body: JSON.stringify({ reason: 'Ware beschädigt' }) });
  assert.equal(credit.status, 201);
  assert.match(credit.body.number, /^AV-\d{4}-\d{6}$/);
  assert.equal(credit.body.creditNoteFor, invoice.body.id);
  const second = await api(`/invoices/${invoice.body.id}/credit-note`, manager, { method: 'POST', body: JSON.stringify({ reason: 'nochmal' }) });
  assert.equal(second.status, 422);

  // Anderer Mandant
  const foreign = await fetch(`${base}/api/v1/invoices/${invoice.body.id}/document`, {
    headers: { authorization: `Bearer ${await token(OWNER_B, T_B, 'owner')}` } });
  assert.equal(foreign.status, 404);
});

test('T-109: GET /me liefert Rolle, Rechte, Filialen und Lizenz – für alle vier Rollen', async () => {
  const cases: Array<[string, string, 'owner' | 'manager' | 'stock_clerk' | 'cashier', string[], string[]]> = [
    // Benutzer, Mandant, Rolle, muss enthalten, darf nicht enthalten
    [OWNER_A, T_A, 'owner', ['user.manage.all', 'invoice.issue', 'report.finance'], []],
    [MANAGER_A, T_A, 'manager', ['invoice.issue', 'sales.order', 'user.manage'], ['user.manage.all', 'tenant.settings']],
    [CLERK_A, T_A, 'stock_clerk', ['stock.receive', 'sales.order'], ['invoice.issue', 'report.finance', 'user.manage']],
    [CASHIER_A, T_A, 'cashier', ['sale.create', 'stock.read'], ['sales.order', 'invoice.issue', 'stock.receive']],
  ];
  for (const [sub, tid, role, must, mustNot] of cases) {
    const me = await api('/me', await token(sub, tid, role));
    assert.equal(me.status, 200, role);
    assert.equal(me.body.user.id, sub);
    assert.equal(me.body.user.role, role);
    for (const p of must) assert.ok(me.body.permissions.includes(p), `${role} braucht ${p}`);
    for (const p of mustNot) assert.ok(!me.body.permissions.includes(p), `${role} darf ${p} nicht haben`);
    assert.equal(me.body.license.mode, 'active');
    assert.equal(Object.hasOwn(me.body.user, 'passwordHash'), false);
  }
  const owner = await api('/me', await token(OWNER_A, T_A, 'owner'));
  assert.deepEqual(owner.body.stores.map((s: { id: string }) => s.id).sort(), [STORE_A1, STORE_A2].sort(), 'Inhaber: alle Filialen');
  const clerk = await api('/me', await token(CLERK_A, T_A, 'stock_clerk'));
  assert.deepEqual(clerk.body.stores.map((s: { id: string }) => s.id), [STORE_A1], 'Lagerist: nur zugewiesene Filiale');
  assert.equal((await fetch(`${base}/api/v1/me`)).status, 401);
});

test('T-110: Bestandsliste und Produktdetail – Einkaufspreis, Filialgrenze, Barcode-Suche, MHD, Seiten', async () => {
  const owner = await token(OWNER_A, T_A, 'owner');
  const cashier = await token(CASHIER_A, T_A, 'cashier');
  const code = `T110-${randomUUID().slice(0, 8)}`;
  await admin.query(`INSERT INTO app.product_barcodes (tenant_id, product_id, code) VALUES ($1, $2, $3)`, [T_A, MILK, code]);
  const lot = await admin.query<{ id: string }>(
    `INSERT INTO app.stock_lots (tenant_id, store_id, product_id, lot_number, expiry_date)
     VALUES ($1, $2, $3, 'L-T110', DATE '2030-01-15') RETURNING id`, [T_A, STORE_A1, MILK]);
  const lotId = lot.rows[0].id;
  const push = await api('/sync/push', owner, {
    method: 'POST', body: JSON.stringify({ movements: [mv({ type: 'purchase_receipt', quantityDelta: '5', lotId, unitCost: '900' })] }),
  });
  assert.equal(push.body.results[0].status, 'accepted');

  // Suche über exakten Barcode
  const found = await api(`/stores/${STORE_A1}/stock?q=${code}`, owner);
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.items.map((i: { productId: string }) => i.productId), [MILK]);
  const milk = found.body.items[0];
  assert.ok('purchasePrice' in milk, 'Inhaber sieht Einkaufspreis');
  assert.equal(milk.nextExpiry, '2030-01-15');
  assert.equal(milk.salePrice, '1350');
  assert.match(milk.quantity, /^-?\d+\.\d{3}$/u);

  // Kassierer: kein Einkaufspreis, fremde Filiale -> 403
  const cash = await api(`/stores/${STORE_A1}/stock?q=${code}`, cashier);
  assert.equal(cash.status, 200);
  assert.equal(Object.hasOwn(cash.body.items[0], 'purchasePrice'), false, 'Kassierer sieht keinen Einkaufspreis');
  assert.equal((await api(`/stores/${STORE_A2}/stock`, cashier)).status, 403);
  const ownerB = await token(OWNER_B, T_B, 'owner');
  assert.equal((await api(`/stores/${STORE_A1}/stock`, ownerB)).status, 404, 'Filiale von Mandant A ist für B unbekannt');
  assert.equal((await api(`/products/${FLOUR_B}?storeId=${STORE_A1}`, ownerB)).status, 404);

  // Seitenweise: zwei Seiten überschneiden sich nicht
  const p1 = await api(`/stores/${STORE_A1}/stock?limit=1`, owner);
  assert.ok(p1.body.nextCursor, 'mehr als ein Produkt vorhanden');
  const p2 = await api(`/stores/${STORE_A1}/stock?limit=1&cursor=${p1.body.nextCursor}`, owner);
  assert.notEqual(p2.body.items[0].productId, p1.body.items[0].productId);
  assert.equal((await api(`/stores/${STORE_A1}/stock?cursor=kaputt`, owner)).status, 400);

  // Filter „unter Mindestbestand“ liefert nur betroffene Produkte
  const low = await api(`/stores/${STORE_A1}/stock?low=true&limit=100`, owner);
  assert.ok(low.body.items.every((i: { belowMin: boolean }) => i.belowMin));

  // Produktdetail mit Chargen
  const detail = await api(`/products/${MILK}?storeId=${STORE_A1}`, cashier);
  assert.equal(detail.status, 200);
  assert.equal(Object.hasOwn(detail.body.product, 'purchasePrice'), false);
  assert.ok(detail.body.barcodes.some((b: { code: string }) => b.code === code));
  assert.ok(detail.body.stock.lots.some((l: { id: string; expiryDate: string }) => l.id === lotId && l.expiryDate === '2030-01-15'));
  assert.equal((await api(`/products/${MILK}?storeId=${STORE_A2}`, cashier)).status, 403);
  assert.equal((await api(`/products/${MILK}`, await token(OWNER_B, T_B, 'owner'))).status, 404);
});

test('T-111: Kunden – Matricule fiscal, Rechte je Rolle, Saldo/Limit, Suche, Audit', async () => {
  const owner = await token(OWNER_A, T_A, 'owner');
  const manager = await token(MANAGER_A, T_A, 'manager');
  const clerk = await token(CLERK_A, T_A, 'stock_clerk');
  const cashier = await token(CASHIER_A, T_A, 'cashier');
  const name = `Grossiste ${randomUUID().slice(0, 6)}`;

  // Kriterium 1: Geschäftskunde ohne Matricule fiscal -> 400 mit verständlicher Meldung am Feld taxId
  const missing = await api('/customers', manager, { method: 'POST', body: JSON.stringify({ name }) });
  assert.equal(missing.status, 400);
  const issue = missing.body.issues.find((i: { path: string[] }) => i.path[0] === 'taxId');
  assert.match(issue.message, /Matricule fiscal/u);
  const badFormat = await api('/customers', manager, { method: 'POST', body: JSON.stringify({ name, taxId: '12AB' }) });
  assert.equal(badFormat.status, 400);
  assert.match(JSON.stringify(badFormat.body.issues), /7 Ziffern/u);

  // Anlegen: Nummer automatisch, Matricule normalisiert, Privatkunde ohne Matricule erlaubt
  const created = await api('/customers', manager, {
    method: 'POST',
    body: JSON.stringify({ name, taxId: ' 1234567a/m/a/000 ', creditLimit: '50000', paymentTermsDays: 30,
      billingAddress: { city: 'Sfax', governorate: 'Sfax' }, preferredLocale: 'ar-TN' }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.match(created.body.number, /^CL-\d{4}-\d{6}$/u);
  assert.equal(created.body.taxId, '1234567A/M/A/000');
  assert.equal(created.body.openBalance, '0');
  assert.equal(created.body.overLimit, false);
  const id = created.body.id as string;
  const individual = await api('/customers', owner, { method: 'POST', body: JSON.stringify({ name: 'Client comptoir', type: 'individual' }) });
  assert.equal(individual.status, 201);

  // Nachträglich zum Geschäftskunden ohne Matricule -> 400 (Prüfung der Datenbank)
  const toBusiness = await api(`/customers/${individual.body.id}`, owner, { method: 'PATCH', body: JSON.stringify({ type: 'business' }) });
  assert.equal(toBusiness.status, 400);
  assert.match(toBusiness.body.message, /Matricule fiscal/u);
  const dup = await api('/customers', owner, { method: 'POST', body: JSON.stringify({ name: 'X', number: created.body.number, taxId: '7654321B' }) });
  assert.equal(dup.status, 409);

  // Kriterium 2: Lagerist liest, ändert nicht; Kassierer hat keinen Zugriff
  const search = await api(`/customers?q=${encodeURIComponent('1234567A')}`, clerk);
  assert.equal(search.status, 200);
  assert.deepEqual(search.body.items.map((c: { id: string }) => c.id), [id]);
  assert.equal((await api(`/customers/${id}`, clerk)).status, 200);
  assert.equal((await api(`/customers/${id}`, clerk, { method: 'PATCH', body: JSON.stringify({ phone: '71000000' }) })).status, 403);
  assert.equal((await api('/customers', clerk, { method: 'POST', body: JSON.stringify({ name: 'Y', type: 'individual' }) })).status, 403);
  assert.equal((await api('/customers', cashier)).status, 403);
  assert.equal((await api(`/customers/${id}`, cashier)).status, 403);

  // Limit ändern -> Audit; Mandant B sieht den Kunden nicht
  const patched = await api(`/customers/${id}`, manager, { method: 'PATCH', body: JSON.stringify({ creditLimit: null }) });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.creditLimit, null);
  const audit = await admin.query(`SELECT action FROM app.audit_log WHERE entity_id = $1 ORDER BY id`, [id]);
  assert.deepEqual(audit.rows.map((r) => r.action), ['customer.create', 'customer.credit_update']);
  assert.equal((await api(`/customers/${id}`, await token(OWNER_B, T_B, 'owner'))).status, 404);

  // Detail des T-105-Kunden: Saldo aus Rechnungen und letzte Belege
  const t105 = await api(`/customers?q=${encodeURIComponent('Épicerie Test')}`, owner);
  const withInvoices = await api(`/customers/${t105.body.items[0].id}`, owner);
  assert.equal(withInvoices.status, 200);
  assert.ok(withInvoices.body.recentInvoices.length >= 1, 'Rechnungen aus T-105');
  assert.ok(withInvoices.body.recentOrders.length >= 1);
  assert.match(withInvoices.body.customer.openBalance, /^-?\d+$/u);
});
