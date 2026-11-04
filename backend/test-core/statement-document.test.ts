import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderStatement } from '../src/core/statement-document.ts';

const base = {
  seller: { name: 'Grossiste <SARL>', taxId: '1111111A' }, customer: { name: 'Épicerie', number: 'CL-1', taxId: null },
  from: '2026-10-01', to: '2026-10-31', currency: 'TND', minorDigits: 3,
};

test('Kontoauszug: Débit/Crédit, laufender Saldo, Summen als data-Attribute, HTML maskiert', () => {
  const html = renderStatement({ ...base, opening: '5000', closing: '75000', entries: [
    { date: '2026-10-02', kind: 'invoice', number: 'FA-2026-000001', reference: null, amount: '100000', balance: '105000' },
    { date: '2026-10-05', kind: 'payment', number: 'cheque', reference: 'CHQ 1', amount: '-30000', balance: '75000' },
  ] });
  assert.match(html, /data-opening="5000"/u);
  assert.match(html, /data-closing="75000"/u);
  assert.match(html, />100,000</u);
  assert.match(html, /data-balance="105000">105,000</u);
  assert.match(html, /Chèque/u);
  assert.match(html, /كشف حساب/u);
  assert.ok(html.includes('Grossiste &lt;SARL&gt;'));
});

test('Kontoauszug: inkonsistente Summen werden nicht gedruckt', () => {
  assert.throws(() => renderStatement({ ...base, opening: '0', closing: '1', entries: [] }), /inkonsistent/u);
});
