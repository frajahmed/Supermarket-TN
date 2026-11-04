import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addToCart, cartTotals, cashSuggestions, lineAmounts, needsApproval, parsePercent, planPayment, saleBody } from '../src/core/pos.ts';
import { parseMoneyInput } from '../src/core/products.ts';
import { documentPath } from '../src/core/orders.ts';

const eau = { productId: 'e', label: 'Eau', unit: 'piece', unitPrice: '750' };
const pain = { productId: 'p', label: 'Pain', unit: 'piece', unitPrice: '230' };

test('Warenkorb: gleiche Ware zusammengefasst, Summe wie der Bon (Datenbank-Test K1: 2,190)', () => {
  let cart = addToCart([], eau);
  cart = addToCart(cart, eau);
  cart = addToCart(cart, pain, '3');
  assert.equal(cart.length, 2);
  assert.deepEqual(cartTotals(cart), { total: '2190', discount: '0', items: 2 });
});

test('Rabatt: Rundung wie app.complete_sale; Freigabe über Limit', () => {
  // DB-Test K3: 10 x 0,750 mit 10 % -> Rabatt 0,750, Bon 6,750
  const l = { ...eau, quantity: '10', discountBp: 1000 };
  assert.deepEqual(lineAmounts(l), { gross: 7500n, discount: 750n, total: 6750n });
  // Halbe Millimes werden aufgerundet: 0,333 kg x 1,500 = 0,4995 -> 0,500
  assert.equal(lineAmounts({ ...eau, unitPrice: '1500', quantity: '0.333', discountBp: 0 }).total, 500n);
  assert.equal(lineAmounts({ ...eau, quantity: '1', discountBp: 333 }).discount, 25n, '0,750 x 3,33 % = 0,024975 -> 0,025');
  assert.equal(needsApproval([l], 500, false), true);
  assert.equal(needsApproval([l], 500, true), false, 'Filialleiter braucht keine Freigabe');
  assert.equal(needsApproval([{ ...l, discountBp: 500 }], 500, false), false, 'genau am Limit erlaubt');
  assert.equal(parsePercent('10'), 1000);
  assert.equal(parsePercent('2,5'), 250);
  assert.equal(parsePercent(''), 0);
  assert.equal(parsePercent('101'), null);
  assert.equal(parsePercent('abc'), null);
});

test('Zahlung: Rückgeld nur bar, Karte nie über Bonbetrag, Teilzahlung Karte + bar', () => {
  assert.deepEqual(planPayment('1350', '2', '', parseMoneyInput), { ok: true, payments: [{ method: 'cash', amount: '2000' }], change: '650' });
  assert.deepEqual(planPayment('1350', '', '1,350', parseMoneyInput), { ok: true, payments: [{ method: 'card', amount: '1350' }], change: '0' });
  assert.deepEqual(planPayment('1350', '1', '0.350', parseMoneyInput),
    { ok: true, payments: [{ method: 'card', amount: '350' }, { method: 'cash', amount: '1000' }], change: '0' });
  assert.deepEqual(planPayment('1350', '1', '', parseMoneyInput), { ok: false, error: 'notEnough' });
  assert.deepEqual(planPayment('1350', '', '2', parseMoneyInput), { ok: false, error: 'cardTooHigh' });
  assert.deepEqual(planPayment('1350', 'x', '', parseMoneyInput), { ok: false, error: 'invalidAmount' });
  assert.deepEqual(cashSuggestions('12150'), ['12150', '13000', '15000', '20000', '50000']);
  assert.deepEqual(cashSuggestions('0'), []);
});

test('Verkaufs-Body: Mengen normiert, Rabatt nur wenn gesetzt, Freigabe optional', () => {
  const r = saleBody('s1', [{ ...eau, quantity: '2.500', discountBp: 0 }, { ...pain, quantity: '1', discountBp: 1000 }],
    [{ method: 'cash', amount: '5000' }], new Date('2026-11-04T18:00:00Z'), { email: 'chef@x.tn', secret: 'pw' });
  assert.ok(r.ok);
  assert.deepEqual(r.body.lines, [{ productId: 'e', quantity: '2.5' }, { productId: 'p', quantity: '1', discountBp: 1000 }]);
  assert.deepEqual(r.body.approval, { email: 'chef@x.tn', secret: 'pw' });
  assert.deepEqual(saleBody('s1', [], [], new Date()), { ok: false, error: 'emptyCart' });
  assert.deepEqual(saleBody('s1', [{ ...eau, quantity: '0', discountBp: 0 }], [], new Date()), { ok: false, error: 'invalidQuantity', productId: 'e' });
  assert.equal(documentPath('receipt', 'x1'), '/api/v1/pos/sales/x1/receipt');
});
