import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDelimiter, importTemplateCsv, mapHeaders, parseCsv, rowsFromCsv } from '../src/core/product-import.ts';

test('CSV: Semikolon (Excel fr), Anführungszeichen, Zeilenumbruch im Feld, BOM, CRLF', () => {
  assert.equal(detectDelimiter('ref;nom;prix'), ';');
  assert.equal(detectDelimiter('ref,nom,prix'), ',');
  assert.deepEqual(parseCsv('﻿a;b\r\n"x;1";"Er sagt ""hi"""\r\n"zwei\nZeilen";\r\n\r\n'),
    [['a', 'b'], ['x;1', 'Er sagt "hi"'], ['zwei\nZeilen', '']]);
});

test('Spalten: Aliase auf Französisch/Englisch/Arabisch, Akzente egal, unbekannte gemeldet', () => {
  const { columns, unknown } = mapHeaders(['Référence', 'Désignation', 'الاسم', 'Prix TTC', 'TVA (%)', 'Code-barre', 'Farbe']);
  assert.deepEqual(columns, { sku: 0, nameFr: 1, nameAr: 2, salePrice: 3, taxRate: 4, barcode: 5 });
  assert.deepEqual(unknown, ['Farbe']);
});

test('Vorlage wird fehlerfrei eingelesen – inkl. Karton und Dezimalkomma', () => {
  const r = rowsFromCsv(importTemplateCsv());
  assert.deepEqual(r.errors, []);
  assert.equal(r.withPrices, true);
  assert.deepEqual(r.rows, [{ line: 2, sku: 'LAIT-1L', name: { fr: 'Lait Délice 1 L', ar: 'حليب ديليس 1 لتر' }, unit: 'piece',
    salePrice: '1350', purchasePrice: '1100', taxRateBp: 700, minStock: '24', trackExpiry: true, barcode: '6194001234567',
    carton: { factor: '12', gtin: '06194001234574' } }]);
});

test('Fehler je Zeile mit Excel-Zeilennummer; gültige Zeilen bleiben', () => {
  const csv = [
    'ref;nom;unite;prix;tva;stock_min;dlc;carton;ean_carton',
    'A1;Eau;litre;0,750;19%;10;non;6;',
    ';Ohne Nummer;;;;;;;',
    'A1;Doppelt;;;;;;;',
    'A3;Falsch;kiste;1.2345;20;x;vielleicht;;123',
    'A4;Prix avec devise;kg;12,500 TND;0,07;;;;',
  ].join('\n');
  const r = rowsFromCsv(csv);
  assert.deepEqual(r.rows.map((x) => [x.line, x.sku, x.unit, x.salePrice, x.taxRateBp, x.trackExpiry, x.carton]),
    [[2, 'A1', 'l', '750', 1900, false, { factor: '6' }], [6, 'A4', 'kg', '12500', 700, undefined, undefined]]);
  assert.deepEqual(r.errors.map((e) => [e.line, e.field, e.code]), [
    [3, 'sku', 'skuMissing'], [4, 'sku', 'duplicateSku'],
    [5, 'unit', 'invalidUnit'], [5, 'salePrice', 'invalidPrice'], [5, 'taxRate', 'invalidTax'], [5, 'minStock', 'invalidQuantity'],
    [5, 'trackExpiry', 'invalidYesNo'], [5, 'cartonBarcode', 'cartonBarcodeWithoutFactor'],
  ]);
});

test('Datei ohne Pflichtspalten oder leer', () => {
  assert.deepEqual(rowsFromCsv('nom;prix\nEau;1').errors.map((e) => e.code), ['noSkuColumn']);
  assert.deepEqual(rowsFromCsv('ref;prix\nA;1').errors.map((e) => e.code), ['noNameColumn']);
  assert.deepEqual(rowsFromCsv('ref;nom\n').errors.map((e) => e.code), ['empty']);
});
