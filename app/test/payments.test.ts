import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canReverse, debitCredit, defaultStatementFrom, paymentBody, statementConsistent, type Statement } from '../src/core/payments.ts';
import { documentPath } from '../src/core/orders.ts';

const today = '2026-11-04';
const form = { amount: '125,5', method: 'cheque' as const, reference: ' CHQ 42 ', receivedAt: '03/11/2026', invoiceId: 'inv1' };

test('Zahlung: Betrag in Millimes, Scheck braucht Nummer, kein Zukunftsdatum', () => {
  const r = paymentBody(form, today);
  assert.ok(r.ok);
  assert.deepEqual(r.body, { amount: '125500', method: 'cheque', reference: 'CHQ 42', receivedAt: '2026-11-03', invoiceId: 'inv1' });
  assert.deepEqual(paymentBody({ ...form, reference: '' }, today), { ok: false, errors: { reference: 'referenceRequired' } });
  const cash = paymentBody({ ...form, method: 'cash', reference: '', receivedAt: '', invoiceId: null }, today);
  assert.ok(cash.ok && !('reference' in cash.body) && !('receivedAt' in cash.body) && !('invoiceId' in cash.body));
  assert.deepEqual(paymentBody({ ...form, amount: '0' }, today), { ok: false, errors: { amount: 'invalidAmount' } });
  assert.deepEqual(paymentBody({ ...form, receivedAt: '05/11/2026' }, today), { ok: false, errors: { receivedAt: 'futureDate' } });
  assert.deepEqual(paymentBody({ ...form, receivedAt: '31/02/2026' }, today), { ok: false, errors: { receivedAt: 'invalidDate' } });
});

const st: Statement = {
  customer: { id: 'c1', name: 'É', number: 'CL-1', openBalance: '65000' }, from: null, to: today, opening: '0', closing: '65000',
  entries: [
    { date: '2026-10-25', kind: 'invoice', documentId: 'i1', number: 'FA-1', reference: null, amount: '100000', balance: '100000', reversed: false },
    { date: '2026-10-30', kind: 'credit_note', documentId: 'i2', number: 'AV-1', reference: null, amount: '-10000', balance: '90000', reversed: false },
    { date: '2026-11-03', kind: 'payment', documentId: 'p1', number: 'cheque', reference: 'CHQ', amount: '-30000', balance: '60000', reversed: true },
    { date: '2026-11-04', kind: 'payment_reversal', documentId: 'p2', number: 'cheque', reference: 'ungedeckt', amount: '30000', balance: '90000', reversed: false },
    { date: '2026-11-04', kind: 'payment', documentId: 'p3', number: 'cash', reference: null, amount: '-25000', balance: '65000', reversed: false },
  ],
};

test('Kontoauszug: Summe stimmt, Débit/Crédit, Storno nur einmal', () => {
  assert.ok(statementConsistent(st));
  assert.equal(statementConsistent({ ...st, closing: '1' }), false);
  assert.deepEqual(debitCredit('-30000'), { debit: null, credit: '30000' });
  assert.deepEqual(debitCredit('100000'), { debit: '100000', credit: null });
  assert.equal(canReverse({ reversesPaymentId: null, reversed: false }), true);
  assert.equal(canReverse({ reversesPaymentId: null, reversed: true }), false);
  assert.equal(canReverse({ reversesPaymentId: 'p1', reversed: false }), false, 'Storno nicht stornierbar');
  assert.equal(defaultStatementFrom('2026-11-04'), '2026-10-01');
  assert.equal(defaultStatementFrom('2026-01-15'), '2025-12-01');
  assert.equal(documentPath('statement', 'c1', 'from=2026-10-01'), '/api/v1/customers/c1/statement/document?from=2026-10-01');
});
