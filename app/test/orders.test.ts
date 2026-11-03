import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiError } from '../src/core/api-client.ts';
import {
  addToDraft, applyScan, baseQuantity, canDeliver, creditLimitInfo, deliveryBody, documentFileName, documentPath,
  fromMilli, initialPick, orderBody, remaining, sendOnce, toMilli, type KeyValueStore, type Order,
} from '../src/core/orders.ts';

class Mem implements KeyValueStore {
  m = new Map<string, string>();
  async getItemAsync(k: string) { return this.m.get(k) ?? null; }
  async setItemAsync(k: string, v: string) { this.m.set(k, v); }
  async deleteItemAsync(k: string) { this.m.delete(k); }
}

test('Kriterium 1: Netzabbruch -> Wiederholung mit derselben clientOpId, Server bucht einmal', async () => {
  const store = new Mem();
  const booked = new Map<string, string>();   // clientOpId -> Lieferung (wie deliver_sales_order)
  let n = 0;
  const server = async (opId: string) => {
    if (!booked.has(opId)) booked.set(opId, `BL-${++n}`);
    return booked.get(opId)!;
  };
  let ids = 0;
  const newId = () => `op-${++ids}`;
  const content = { l1: '3' };
  // 1. Versuch: Server bucht, Antwort geht verloren
  await assert.rejects(sendOnce(store, 'delivery:o1', content, newId, async (id) => { await server(id); throw new TypeError('Network request failed'); }));
  assert.match(store.m.get('stn.pending-op.delivery:o1') ?? '', /op-1/u, 'ID bleibt für den nächsten Versuch');
  // 2. Versuch mit gleichem Inhalt: dieselbe ID -> dieselbe Lieferung
  assert.equal(await sendOnce(store, 'delivery:o1', { l1: '3' }, newId, server), 'BL-1');
  assert.equal(booked.size, 1, 'nur eine Buchung');
  assert.equal(store.m.size, 0, 'nach Erfolg verworfen');
  // Nächste (Teil-)Lieferung bekommt eine neue ID
  assert.equal(await sendOnce(store, 'delivery:o1', content, newId, server), 'BL-2');
});

test('Liegengebliebene ID wird bei anderem Inhalt NICHT wiederverwendet', async () => {
  const store = new Mem();
  let ids = 0;
  await assert.rejects(sendOnce(store, 'order:s1', { c: 'A' }, () => `op-${++ids}`, async () => { throw new TypeError('offline'); }));
  const used: string[] = [];
  await sendOnce(store, 'order:s1', { c: 'B' }, () => `op-${++ids}`, async (id) => { used.push(id); return id; });
  assert.deepEqual(used, ['op-2']);
});

test('Fachliche Ablehnung (4xx) verwirft die ID; Serverfehler (5xx) behält sie', async () => {
  const store = new Mem();
  await assert.rejects(sendOnce(store, 'x', 1, () => 'a', async () => { throw new ApiError(422, 'Menge', {}); }));
  assert.equal(store.m.size, 0);
  await assert.rejects(sendOnce(store, 'x', 1, () => 'b', async () => { throw new ApiError(503, 'weg', {}); }));
  assert.match(store.m.get('stn.pending-op.x') ?? '', /"b"/u);
});

test('Kriterium 2: Kreditlimit-Antwort mit Beträgen; Übersteuern nur wenn der Server es erlaubt', () => {
  const info = creditLimitInfo(new ApiError(409, 'Kreditlimit', { code: 'CREDIT_LIMIT', open: '500', order: '5400', limit: '1000', canOverride: false }));
  assert.deepEqual(info, { open: '500', order: '5400', limit: '1000', canOverride: false });
  assert.equal(creditLimitInfo(new ApiError(409, 'x', { code: 'CREDIT_LIMIT', open: '1', order: '2', limit: '3', canOverride: true }))?.canOverride, true);
  assert.equal(creditLimitInfo(new ApiError(409, 'SKU', { message: 'x' })), null);
  assert.equal(creditLimitInfo(new Error('x')), null);
});

test('Mengen exakt in Tausendsteln', () => {
  assert.equal(toMilli('1.5'), 1500n);
  assert.equal(fromMilli(toMilli('0.250') + toMilli('0.750')), '1');
  assert.equal(fromMilli(-1250n), '-1.25');
  assert.throws(() => toMilli('1.2345'));
});

const milk = { productId: 'p1', label: 'Lait', unit: 'piece', factor: '1' };
const carton = { productId: 'p1', label: 'Lait', unit: 'piece', packagingId: 'k12', packagingLabel: 'Carton 12', factor: '12' };

test('Erfassung: gleiche Position zusammenfassen, Karton in Basiseinheit umrechnen, Fehler', () => {
  let lines = addToDraft([], milk);
  lines = addToDraft(lines, milk, '2');
  lines = addToDraft(lines, carton, '3');
  assert.equal(lines.length, 2);
  assert.equal(lines[0]!.quantity, '3');
  assert.equal(baseQuantity(lines[1]!), '36');
  const ok = orderBody({ storeId: 's1', customerId: 'c1', lines, note: ' bitte morgens ' }, 'op-1');
  assert.ok(ok.ok);
  assert.deepEqual(ok.body, { storeId: 's1', customerId: 'c1', clientOpId: 'op-1', note: 'bitte morgens',
    lines: [{ productId: 'p1', quantity: '3' }, { productId: 'p1', quantity: '36', packagingId: 'k12' }] });
  assert.deepEqual(orderBody({ storeId: 's1', customerId: null, lines, }, 'x'), { ok: false, error: 'noCustomer' });
  assert.deepEqual(orderBody({ storeId: 's1', customerId: 'c', lines: [] }, 'x'), { ok: false, error: 'noLines' });
  const half = orderBody({ storeId: 's1', customerId: 'c', lines: [{ ...lines[1]!, quantity: '1.5' }] }, 'x');
  assert.deepEqual(half, { ok: false, error: 'wholePackagesOnly', lineKey: 'p1:k12' });
  const zero = orderBody({ storeId: 's1', customerId: 'c', lines: [{ ...lines[0]!, quantity: '0' }] }, 'x');
  assert.ok(!zero.ok && zero.error === 'invalidQuantity');
  assert.equal(baseQuantity({ ...lines[0]!, quantity: '0.25', factor: '1' }), '0.25');
});

const order: Order = {
  id: 'o1', number: 'SO-2026-000001', status: 'confirmed', storeId: 's1', customerId: 'c1', customerName: 'Épicerie',
  currency: 'TND', estimatedGross: '0', requestedDate: null, note: null, creditOverrideReason: null, deliveries: [],
  lines: [
    { id: 'l1', lineNo: 1, productId: 'p1', sku: 'LAIT', productName: { fr: 'Lait' }, unit: 'piece', packagingId: null,
      packagingName: null, packagingFactor: null, quantity: '10.000', quantityDelivered: '4.000', unitPrice: '1350', discountBp: 0, taxRateBp: 700 },
    { id: 'l2', lineNo: 2, productId: 'p2', sku: 'FAR', productName: { fr: 'Farine' }, unit: 'kg', packagingId: null,
      packagingName: null, packagingFactor: null, quantity: '5.000', quantityDelivered: '5.000', unitPrice: '900', discountBp: 0, taxRateBp: 0 },
  ],
};

test('Lieferung: Restmengen, Teillieferung, Übermenge abgelehnt, leere Lieferung abgelehnt', () => {
  assert.equal(remaining(order.lines[0]!), '6');
  assert.equal(remaining(order.lines[1]!), '0');
  assert.ok(canDeliver(order));
  assert.equal(canDeliver({ ...order, status: 'draft' }), false);
  const pick = initialPick(order);
  assert.deepEqual(pick, { l1: '6', l2: '0' });
  const partial = deliveryBody(order, { ...pick, l1: '2,5' }, 'op');
  assert.ok(partial.ok);
  assert.deepEqual(partial.body, { clientOpId: 'op', lines: [{ orderLineId: 'l1', quantity: '2.5' }] });
  assert.deepEqual(deliveryBody(order, { l1: '7' }, 'op'), { ok: false, error: 'exceedsRemaining', lineId: 'l1' });
  assert.deepEqual(deliveryBody(order, { l1: '0', l2: '' }, 'op'), { ok: false, error: 'nothingToDeliver' });
});

test('Scan beim Kommissionieren: erster Scan zählt von 0, Karton-Scan, Rest wird nicht überschritten', () => {
  const touched = new Set<string>();
  let pick = initialPick(order);
  const first = applyScan(order, pick, 'p1', '1', touched);
  assert.ok(first.ok);
  pick = first.pick;
  assert.equal(pick.l1, '1');
  const box = applyScan(order, pick, 'p1', '5', touched);
  assert.ok(box.ok && box.pick.l1 === '6');
  assert.deepEqual(applyScan(order, box.ok ? box.pick : pick, 'p1', '1', touched), { ok: false, error: 'exceedsRemaining' });
  assert.deepEqual(applyScan(order, pick, 'p9', '1', touched), { ok: false, error: 'notInOrder' });
});

test('Dokumente: Pfad und sicherer Dateiname', () => {
  assert.equal(documentPath('invoice', 'i1'), '/api/v1/invoices/i1/document');
  assert.equal(documentPath('delivery', 'd1'), '/api/v1/deliveries/d1/document');
  assert.equal(documentFileName('FA-2026-000012'), 'FA-2026-000012.pdf');
  assert.equal(documentFileName('../x y'), '.._x_y.pdf');
});
