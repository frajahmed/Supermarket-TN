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
import { AppModule } from '../app.module';
import { formatAmount, parseAmount, taxFromGross } from '../common/money';

const T_A = randomUUID(), T_B = randomUUID();
const STORE_A1 = randomUUID(), STORE_A2 = randomUUID(), STORE_B = randomUUID();
const OWNER_A = randomUUID(), CLERK_A = randomUUID(), CASHIER_A = randomUUID(), OWNER_B = randomUUID();
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
       ($1,$5,'owner@a.tn','O','owner',$7,NULL), ($2,$5,'clerk@a.tn','C','stock_clerk',NULL,NULL),
       ($3,$5,'cash@a.tn','K','cashier',NULL,$8), ($4,$6,'owner@b.tn','OB','owner',NULL,NULL)`,
    [OWNER_A, CLERK_A, CASHIER_A, OWNER_B, T_A, T_B, await hashSecret('Chef-Passwort-2026'), await hashSecret('4711')]);
  await admin.query(
    `INSERT INTO app.user_store_access (tenant_id, user_id, store_id) VALUES ($1,$2,$4), ($1,$3,$4)`,
    [T_A, CLERK_A, CASHIER_A, STORE_A1]);
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
