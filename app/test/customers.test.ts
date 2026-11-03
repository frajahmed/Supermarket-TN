import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availableCredit, creditState, customerBodyFromForm, EMPTY_CUSTOMER_FORM, fieldErrorsFromServer, formFromCustomer,
  isValidTaxId, normalizeTaxId, type Customer,
} from '../src/core/customers.ts';
import { tileRoute } from '../src/core/home.ts';

test('Matricule fiscal: Pflicht für Geschäftskunden, Format geprüft, normalisiert', () => {
  const missing = customerBodyFromForm({ ...EMPTY_CUSTOMER_FORM, name: 'Grossiste' }, { canEditCredit: true });
  assert.ok(!missing.ok);
  assert.equal(missing.errors.taxId, 'taxIdRequired');
  const bad = customerBodyFromForm({ ...EMPTY_CUSTOMER_FORM, name: 'G', taxId: '12AB' }, { canEditCredit: true });
  assert.ok(!bad.ok && bad.errors.taxId === 'taxIdInvalid');
  const individual = customerBodyFromForm({ ...EMPTY_CUSTOMER_FORM, type: 'individual', name: 'Client' }, { canEditCredit: true });
  assert.ok(individual.ok && individual.body.taxId === null, 'Privatkunde ohne Matricule');
  assert.equal(normalizeTaxId(' 1234567a/m/a/000 '), '1234567A/M/A/000');
  for (const ok of ['1234567A', '1234567A/M/A/000', '3333333C/A/000', '1234567AAM000']) assert.ok(isValidTaxId(ok), ok);
  for (const no of ['123456A', '12345678', 'ABCDEFGH']) assert.ok(!isValidTaxId(no), no);
});

test('Kundenformular → Body: Limit leer = kein Limit, Beträge in Millimes, Adresse ohne leere Felder', () => {
  const r = customerBodyFromForm({ ...EMPTY_CUSTOMER_FORM, name: ' Épicerie ', taxId: '1234567a', city: 'Sfax',
    creditLimit: '5000', paymentTermsDays: '30' }, { canEditCredit: true });
  assert.ok(r.ok);
  assert.equal(r.body.name, 'Épicerie');
  assert.equal(r.body.taxId, '1234567A');
  assert.equal(r.body.creditLimit, '5000000');
  assert.equal(r.body.paymentTermsDays, 30);
  assert.deepEqual(r.body.billingAddress, { city: 'Sfax' });
  const noLimit = customerBodyFromForm({ ...EMPTY_CUSTOMER_FORM, name: 'X', taxId: '1234567A' }, { canEditCredit: true });
  assert.ok(noLimit.ok && noLimit.body.creditLimit === null);
  const noCredit = customerBodyFromForm({ ...EMPTY_CUSTOMER_FORM, name: 'X', taxId: '1234567A', creditLimit: '1' }, { canEditCredit: false });
  assert.ok(noCredit.ok && !('creditLimit' in noCredit.body) && !('paymentTermsDays' in noCredit.body));
  const errs = customerBodyFromForm({ ...EMPTY_CUSTOMER_FORM, name: '', taxId: '1234567A', email: 'kaputt',
    paymentTermsDays: '400', creditLimit: '1.2345' }, { canEditCredit: true });
  assert.ok(!errs.ok);
  assert.deepEqual(errs.errors, { name: 'nameRequired', email: 'invalidEmail', paymentTermsDays: 'invalidDays', creditLimit: 'invalidPrice' });
});

test('Serverfehler (400) werden den Feldern zugeordnet', () => {
  assert.deepEqual(fieldErrorsFromServer({ message: 'x', issues: [{ path: ['taxId'], message: 'Matricule fiscal …' }] }), { taxId: 'taxIdInvalid' });
  assert.deepEqual(fieldErrorsFromServer(null), {});
});

test('Kreditlimit-Ampel und verfügbarer Rahmen (BigInt, kein Gleitkomma)', () => {
  assert.equal(creditState('0', null), 'none');
  assert.equal(creditState('7999', '10000'), 'ok');
  assert.equal(creditState('8000', '10000'), 'near');
  assert.equal(creditState('10001', '10000'), 'over');
  assert.equal(creditState('0', '0'), 'ok');
  assert.equal(availableCredit('2500', '10000'), '7500');
  assert.equal(availableCredit('12000', '10000'), '0');
  assert.equal(availableCredit('1', null), null);
  assert.equal(creditState('9007199254740993000', '9007199254740993001'), 'near', 'große Beträge exakt');
});

test('Formular aus Kunde und zurück ist verlustfrei; Kachel Kunden führt zur Liste', () => {
  const c: Customer = { id: 'c1', number: 'CL-2026-000001', type: 'business', name: 'Épicerie', legalName: null,
    taxId: '1234567A/M/A/000', vatExempt: false, paymentTermsDays: 30, creditLimit: '50000', phone: null, email: null,
    billingAddress: { city: 'Sfax' }, preferredLocale: 'ar-TN', isActive: true, openBalance: '0', overLimit: false };
  const back = customerBodyFromForm(formFromCustomer(c), { canEditCredit: true });
  assert.ok(back.ok);
  assert.equal(back.body.creditLimit, '50000');
  assert.equal(back.body.taxId, '1234567A/M/A/000');
  assert.equal(tileRoute('customers'), '/customers');
});

test('Saldo mit Vorzeichen formatieren', async () => {
  const { formatSignedTndMinor } = await import('../src/core/money.ts');
  assert.equal(formatSignedTndMinor('-1500', 'en'), '-1.500');
  assert.equal(formatSignedTndMinor('2000', 'en'), '2.000');
});
