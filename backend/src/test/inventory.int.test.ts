/**
 * Integrationstest: echte NestJS-App + echte PostgreSQL-DB (Schema 001 + 002).
 *
 * Voraussetzungen (Umgebungsvariablen):
 *   ADMIN_DATABASE_URL  Superuser/Owner-Verbindung zum Anlegen der Testdaten
 *   DATABASE_URL        Verbindung als app_user (RLS aktiv)
 *
 * Ablauf: Schlüsselpaar erzeugen -> Testmandanten anlegen -> App starten ->
 * Offline-Stapel pushen -> Idempotenz, Rechte, Live-Event und Mandantentrennung prüfen.
 */
import 'reflect-metadata';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AddressInfo } from 'node:net';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { exportSPKI, generateKeyPair, SignJWT, KeyLike } from 'jose';
import { Client } from 'pg';
import { io, Socket } from 'socket.io-client';
import { AppModule } from '../app.module';
import { formatAmount, parseAmount, taxFromGross } from '../common/money';

const T_A = randomUUID(), T_B = randomUUID();
const STORE_A1 = randomUUID(), STORE_A2 = randomUUID(), STORE_B = randomUUID();
const OWNER_A = randomUUID(), CLERK_A = randomUUID(), CASHIER_A = randomUUID(), OWNER_B = randomUUID();
const MILK = randomUUID(), FLOUR_B = randomUUID();

let app: INestApplication;
let base = '';
let privateKey: KeyLike;
let admin: Client;

async function token(sub: string, tid: string, role: string) {
  return new SignJWT({ tid, role })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(sub).setIssuer('warenwirtschaft').setIssuedAt().setExpirationTime('15m')
    .sign(privateKey);
}

async function api(path: string, tok: string, init: RequestInit = {}) {
  const res = await fetch(`${base}/api/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json() as any };
}

const mv = (over: Record<string, unknown>) => ({
  clientOpId: randomUUID(), storeId: STORE_A1, productId: MILK,
  occurredAt: new Date().toISOString(), ...over,
});

before(async () => {
  const kp = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  privateKey = kp.privateKey;
  process.env.JWT_PUBLIC_KEY = await exportSPKI(kp.publicKey);
  process.env.OUTBOX_POLL_MS = '50';

  admin = new Client({ connectionString: process.env.ADMIN_DATABASE_URL });
  await admin.connect();
  await admin.query(
    `INSERT INTO app.tenants (id, slug, name) VALUES ($1, $3, 'A'), ($2, $4, 'B')`,
    [T_A, T_B, `int-a-${T_A.slice(0, 8)}`, `int-b-${T_B.slice(0, 8)}`]);
  await admin.query(
    `INSERT INTO app.stores (id, tenant_id, code, name) VALUES ($1,$4,'S1','A1'), ($2,$4,'S2','A2'), ($3,$5,'B1','B1')`,
    [STORE_A1, STORE_A2, STORE_B, T_A, T_B]);
  await admin.query(
    `INSERT INTO app.users (id, tenant_id, email, display_name, role) VALUES
       ($1,$5,'owner@a.tn','O','owner'), ($2,$5,'clerk@a.tn','C','stock_clerk'),
       ($3,$5,'cash@a.tn','K','cashier'), ($4,$6,'owner@b.tn','OB','owner')`,
    [OWNER_A, CLERK_A, CASHIER_A, OWNER_B, T_A, T_B]);
  await admin.query(
    `INSERT INTO app.user_store_access (tenant_id, user_id, store_id) VALUES ($1,$2,$4), ($1,$3,$4)`,
    [T_A, CLERK_A, CASHIER_A, STORE_A1]);
  await admin.query(
    `INSERT INTO app.products (id, tenant_id, sku, name, sale_price, min_stock) VALUES
       ($1,$3,'LAIT','{"fr":"Lait 1 L","ar":"حليب 1 لتر"}',1350,10), ($2,$4,'FARINE','{"fr":"Farine"}',900,5)`,
    [MILK, FLOUR_B, T_A, T_B]);

  app = await NestFactory.create(AppModule, { logger: ['error'] });
  app.setGlobalPrefix('api/v1', { exclude: ['health'] });
  await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
});

after(async () => {
  await app?.close();
  // Testdaten bleiben im Journal (append-only) – Test läuft gegen eine Wegwerf-DB.
  await admin?.end();
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

test('Gefälschter Mandant im Token wird durch Signaturprüfung abgewiesen', async () => {
  const other = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
  const forged = await new SignJWT({ tid: T_A, role: 'owner' }).setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(OWNER_B).setIssuer('warenwirtschaft').setExpirationTime('5m').sign(other.privateKey);
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
