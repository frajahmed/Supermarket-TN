import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countMovements, lossMovement, parseDateInput, pushOnce, receiptMovement, summarize, type Movement } from '../src/core/warehouse.ts';
import type { KeyValueStore } from '../src/core/orders.ts';
import { tileRoute } from '../src/core/home.ts';

const now = new Date('2026-11-03T10:00:00Z');
let n = 0;
const id = () => `op-${++n}`;

test('Kriterium 1: Inventurdifferenz bucht inventory_count mit Vorzeichen', () => {
  const r = countMovements('s1', [
    { productId: 'a', expected: '10.000', counted: '7' },     // −3
    { productId: 'b', expected: '2.500', counted: '3,5' },    // +1
    { productId: 'c', expected: '5.000', counted: '5' },      // keine Differenz
    { productId: 'd', expected: '4.000', counted: '' },       // nicht gezählt
    { productId: 'e', expected: '-2.000', counted: '0' },     // negativer Systembestand -> +2
  ], id, now);
  assert.ok(r.ok);
  assert.equal(r.counted, 4);
  assert.deepEqual(r.movements.map((m) => [m.productId, m.type, m.quantityDelta, m.refType]),
    [['a', 'inventory_count', '-3', 'count'], ['b', 'inventory_count', '1', 'count'], ['e', 'inventory_count', '2', 'count']]);
  assert.deepEqual(countMovements('s1', [{ productId: 'a', expected: '1', counted: '' }], id, now), { ok: false, error: 'nothingCounted' });
  assert.deepEqual(countMovements('s1', [{ productId: 'a', expected: '1', counted: '-1' }], id, now), { ok: false, error: 'invalidQuantity', productId: 'a' });
});

test('Kriterium 2: Verlust ohne Begründung wird verhindert', () => {
  const base = { storeId: 's1', productId: 'p', quantity: '2', note: '', clientOpId: 'x', now };
  assert.deepEqual(lossMovement({ ...base, reason: null }), { ok: false, error: 'reasonRequired' });
  assert.deepEqual(lossMovement({ ...base, reason: 'other' }), { ok: false, error: 'reasonRequired' }, 'Sonstiges braucht Text');
  const ok = lossMovement({ ...base, reason: 'expired', lotId: 'lot1' });
  assert.ok(ok.ok);
  assert.equal(ok.movement.quantityDelta, '-2');
  assert.equal(ok.movement.reason, 'expired');
  assert.equal(ok.movement.lotId, 'lot1');
  const other = lossMovement({ ...base, reason: 'other', note: 'Ratten' });
  assert.ok(other.ok && other.movement.reason === 'other: Ratten');
  assert.deepEqual(lossMovement({ ...base, quantity: '0', reason: 'damaged' }), { ok: false, error: 'invalidQuantity' });
});

test('Wareneingang: Karton × Faktor, MHD-Pflicht, Datumsformate der Packung', () => {
  const base = { storeId: 's1', productId: 'p', packs: '3', factor: '12', packaged: true, trackExpiry: true,
    expiry: '31/12/2027', lotNumber: ' L42 ', clientOpId: 'x', now };
  const r = receiptMovement(base);
  assert.ok(r.ok);
  assert.equal(r.movement.quantityDelta, '36');
  assert.deepEqual(r.movement.lot, { expiryDate: '2027-12-31', lotNumber: 'L42' });
  assert.deepEqual(receiptMovement({ ...base, expiry: '' }), { ok: false, error: 'expiryRequired' });
  const noTrack = receiptMovement({ ...base, expiry: '', trackExpiry: false });
  assert.ok(noTrack.ok && noTrack.movement.lot === undefined);
  assert.deepEqual(receiptMovement({ ...base, expiry: '31/02/2027' }), { ok: false, error: 'invalidDate' });
  assert.deepEqual(receiptMovement({ ...base, packs: '1.5' }), { ok: false, error: 'wholePackagesOnly' });
  const kg = receiptMovement({ ...base, packaged: false, factor: '1', packs: '2,250', expiry: '' , trackExpiry: false });
  assert.ok(kg.ok && kg.movement.quantityDelta === '2.25');
  assert.equal(parseDateInput('1.3.2028'), '2028-03-01');
  assert.equal(parseDateInput('2028-03-01'), '2028-03-01');
  assert.equal(parseDateInput('März'), null);
});

class Mem implements KeyValueStore {
  m = new Map<string, string>();
  async getItemAsync(k: string) { return this.m.get(k) ?? null; }
  async setItemAsync(k: string, v: string) { this.m.set(k, v); }
  async deleteItemAsync(k: string) { this.m.delete(k); }
}

test('Stapel nach Netzabbruch mit denselben clientOpIds erneut senden', async () => {
  const store = new Mem();
  const seen = new Set<string>();
  const server = async (ms: Movement[]) => ms.map((m) => {
    const dup = seen.has(m.clientOpId); seen.add(m.clientOpId);
    return { clientOpId: m.clientOpId, status: dup ? 'duplicate' as const : 'accepted' as const };
  });
  const content = { a: '7' };
  const build = () => countMovements('s1', [{ productId: 'a', expected: '10', counted: '7' }], id, now) as { movements: Movement[] } & { ok: true };
  await assert.rejects(pushOnce(store, 'count:s1', content, () => build().movements, async (ms) => { await server(ms); throw new TypeError('offline'); }));
  const again = await pushOnce(store, 'count:s1', content, () => build().movements, server);
  assert.deepEqual(again.map((r) => r.status), ['duplicate'], 'zweiter Versuch bucht nicht erneut');
  assert.equal(store.m.size, 0);
  assert.deepEqual(summarize([{ clientOpId: '1', status: 'accepted' }, { clientOpId: '2', status: 'rejected', error: 'x' }]),
    { booked: 1, rejected: [{ clientOpId: '2', error: 'x' }] });
  assert.equal(tileRoute('warehouse'), '/warehouse');
});
