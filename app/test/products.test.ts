import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changedFields, createFromUnknownBarcode, describeScan, expiryState, moneyInputFromMinor, normalizeScannedCode,
  parseMoneyInput, productBodyFromForm, productLabel, stockState, trimDecimal, type BarcodeLookup, type ProductForm,
} from '../src/core/products.ts';
import { tileRoute } from '../src/core/home.ts';

const milk = { id: 'p1', name: { fr: 'Lait 1 L', ar: 'حليب 1 لتر' }, unit: 'piece' };

test('Kriterium 1: Karton-GTIN zeigt Gebinde und Menge je Scan', () => {
  const carton: BarcodeLookup = {
    product: milk, barcode: { code: '06191234000017', symbology: null },
    packaging: { id: 'k1', code: 'carton', name: { fr: 'Carton de 12', ar: 'كرتونة 12' }, factor: '12.000' },
    quantityPerScan: '12.000',
  };
  assert.deepEqual(describeScan(carton, 'ar'), { productId: 'p1', label: 'حليب 1 لتر', perScan: '12', packagingLabel: 'كرتونة 12' });
  const piece: BarcodeLookup = { product: milk, barcode: { code: '6191234000010', symbology: 'ean13' }, packaging: null, quantityPerScan: '1.000' };
  assert.deepEqual(describeScan(piece, 'en'), { productId: 'p1', label: 'Lait 1 L', perScan: '1', packagingLabel: null });
});

test('Kriterium 2: unbekannter Barcode → Anlegen mit vorausgefülltem Barcode', () => {
  assert.deepEqual(createFromUnknownBarcode('6191234999999', 'ean13'), { barcode: '6191234999999', symbology: 'ean13' });
  assert.deepEqual(createFromUnknownBarcode('X-1', 'unbekannt'), { barcode: 'X-1', symbology: 'ean13' });
  assert.equal(normalizeScannedCode('  6191234 \n'), '6191234');
  assert.equal(normalizeScannedCode('   '), null);
  assert.equal(normalizeScannedCode('9'.repeat(101)), null);
});

test('Produktname: App-Sprache, sonst fr → ar → en', () => {
  assert.equal(productLabel({ fr: 'Lait', ar: 'حليب' }, 'ar'), 'حليب');
  assert.equal(productLabel({ ar: 'حليب' }, 'en'), 'حليب');
  assert.equal(productLabel(null, 'fr'), '');
});

test('Beträge: TND mit 3 Stellen, ohne Gleitkomma', () => {
  assert.equal(parseMoneyInput('13,5'), '13500');
  assert.equal(parseMoneyInput('1.350'), '1350');
  assert.equal(parseMoneyInput('0.001'), '1');
  assert.equal(parseMoneyInput('7'), '7000');
  assert.equal(parseMoneyInput('1.2345'), null, 'mehr als 3 Stellen');
  assert.equal(parseMoneyInput('1 000'), null);
  assert.equal(parseMoneyInput('-1'), null);
  assert.equal(moneyInputFromMinor('1350'), '1.350');
  assert.equal(moneyInputFromMinor('5'), '0.005');
  assert.equal(moneyInputFromMinor(null), '');
  assert.equal(trimDecimal('0.250'), '0.25');
  assert.equal(trimDecimal('-3.000'), '-3');
});

test('Bestand und MHD: Warnstufen', () => {
  assert.equal(stockState('-2.000', '0'), 'negative');
  assert.equal(stockState('6.500', '10.000'), 'low');
  assert.equal(stockState('10.000', '10.000'), 'ok');
  assert.equal(expiryState('2026-11-02', '2026-11-03'), 'expired');
  assert.equal(expiryState('2026-11-10', '2026-11-03'), 'soon');
  assert.equal(expiryState('2026-11-11', '2026-11-03'), 'ok');
  assert.equal(expiryState(null, '2026-11-03'), null);
});

const form: ProductForm = {
  sku: ' LAIT-1 ', nameFr: 'Lait', nameAr: '', nameEn: '', unit: 'piece',
  salePrice: '1,350', purchasePrice: '0.9', taxRateBp: 700, minStock: '10', trackExpiry: true,
};

test('Produktformular: Pflichtfelder, Preise nur mit Preisrecht', () => {
  const withPrices = productBodyFromForm(form, { canEditPrices: true, source: 'barcode' });
  assert.ok(withPrices.ok);
  assert.deepEqual(withPrices.body, {
    sku: 'LAIT-1', name: { fr: 'Lait' }, unit: 'piece', taxRateBp: 700, trackExpiry: true, source: 'barcode',
    minStock: '10', salePrice: '1350', purchasePrice: '900',
  });
  const clerk = productBodyFromForm(form, { canEditPrices: false });
  assert.ok(clerk.ok && !('salePrice' in clerk.body) && !('purchasePrice' in clerk.body), 'Lagerist sendet keine Preise');

  const bad = productBodyFromForm({ ...form, sku: ' ', nameFr: '', salePrice: '1.2345', minStock: 'x' }, { canEditPrices: true });
  assert.ok(!bad.ok);
  assert.deepEqual(bad.errors, { sku: 'skuRequired', nameFr: 'nameRequired', salePrice: 'invalidPrice', minStock: 'invalidQuantity' });
});

test('Ändern: nur geänderte Felder; Kachel Produkte führt zur Liste', () => {
  assert.deepEqual(changedFields({ sku: 'A', name: { fr: 'x' }, minStock: '1' }, { sku: 'A', name: { fr: 'y' }, minStock: '1' }), { name: { fr: 'y' } });
  assert.deepEqual(changedFields({ sku: 'A' }, { sku: 'A' }), {});
  assert.equal(tileRoute('products'), '/products');
  assert.equal(tileRoute('pos'), '/pos');
  assert.equal(tileRoute('users'), null);
  assert.equal(tileRoute('orders'), '/orders');
});
