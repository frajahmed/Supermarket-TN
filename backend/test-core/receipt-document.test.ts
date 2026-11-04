import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderReceipt } from '../src/core/receipt-document.ts';

const base = {
  seller: { name: 'Supérette <Sfax>', taxId: '1234567A', store: 'Magasin 1' }, receiptNumber: '42', deviceName: 'Caisse 1',
  cashier: 'Amira', completedAt: '2026-11-04T18:30:00Z', voidsReceiptNumber: null, voidReason: null,
  lines: [{ productName: 'Eau 1,5 L', quantity: '2.000', unitPrice: '750', discount: '75', taxRateBp: 1900, lineTotal: '1425' }],
  payments: [{ method: 'cash', amount: '1425' }],
  totals: { gross: '1425', tax: '228', net: '1197', discount: '75' },
};

test('Kassenbon: Summen als data-Attribute, Rabatt, zweisprachig, maskiert', () => {
  const html = renderReceipt(base);
  assert.match(html, /data-total-gross="1425">1,425 TND/u);
  assert.match(html, /data-total-tax="228"/u);
  assert.match(html, /2 × 0,750 − 0,075/u);
  assert.match(html, /شكرا لزيارتكم/u);
  assert.ok(html.includes('Supérette &lt;Sfax&gt;'));
  assert.ok(!html.includes('ANNULATION'));
});

test('Storno-Bon zeigt Bezug und Begründung', () => {
  const html = renderReceipt({ ...base, receiptNumber: '43', voidsReceiptNumber: '42', voidReason: 'Falsch gescannt',
    lines: [{ ...base.lines[0]!, quantity: '-2.000', discount: '-75', lineTotal: '-1425' }],
    totals: { gross: '-1425', tax: '-228', net: '-1197', discount: '-75' }, payments: [{ method: 'cash', amount: '-1425' }] });
  assert.match(html, /ANNULATION du ticket N° 42/u);
  assert.match(html, /Falsch gescannt/u);
  assert.match(html, /data-total-gross="-1425">−1,425/u);
});
