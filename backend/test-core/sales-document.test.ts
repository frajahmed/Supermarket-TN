import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, formatMinor, formatQuantity, renderSalesDocument, type SalesDocumentInput } from '../src/core/sales-document.ts';

const invoice: SalesDocumentInput = {
  kind: 'invoice', number: 'FA-2026-000001', date: '2026-11-03', dueDate: '2026-12-03', reference: 'SO-2026-000001',
  currency: 'TND', minorDigits: 3,
  seller: { name: 'Grossiste Flow SARL', taxId: '1111111A/M/000' },
  customer: { name: 'Épicerie <El Amel>', taxId: '2222222B/A/000', address: 'Sfax' },
  lines: [
    { description: 'زيت 1 لتر', quantity: '70.000', unitPrice: '4200', taxRateBp: 1900, lineNet: '294000' },
    { description: 'Pâtes 500 g', quantity: '2.500', unitPrice: '1200', discountBp: 500, taxRateBp: 700, lineNet: '2850' },
  ],
  totals: { net: '296850', tax: '56060', stamp: '1000', gross: '353910',
    breakdown: [{ rateBp: 1900, net: '294000', tax: '55860' }, { rateBp: 700, net: '2850', tax: '200' }] },
};

const attr = (html: string, name: string) => html.match(new RegExp(`${name}="([^"]*)"`))?.[1];

test('Beträge: Minor Units mit 3 Stellen, Tausendertrennung, negativ', () => {
  assert.equal(formatMinor('353910', 3), '353,910');
  assert.equal(formatMinor('1234567890', 3), '1 234 567,890');
  assert.equal(formatMinor('5', 3), '0,005');
  assert.equal(formatMinor('-1000', 3), '−1,000');
  assert.equal(formatMinor('399', 2), '3,99');
  assert.equal(formatQuantity('70.000'), '70');
  assert.equal(formatQuantity('2.500'), '2,5');
});

test('Rechnung: Summen im Dokument = übergebene Summen (Rohwert und Anzeige)', () => {
  const html = renderSalesDocument(invoice);
  assert.equal(attr(html, 'data-total-net'), '296850');
  assert.equal(attr(html, 'data-total-tax'), '56060');
  assert.equal(attr(html, 'data-total-stamp'), '1000');
  assert.equal(attr(html, 'data-total-gross'), '353910');
  assert.match(html, />353,910 TND</);
  assert.match(html, /data-tax-rate="1900" data-tax="55860"/);
  assert.match(html, /data-tax-rate="700" data-tax="200"/);
});

test('Rechnung: zweisprachig, Matricule fiscal beider Seiten, TVA je Satz, Timbre', () => {
  const html = renderSalesDocument(invoice);
  for (const s of ['Facture', 'فاتورة', 'Matricule fiscal', 'المعرف الجبائي', '1111111A/M/000', '2222222B/A/000',
    'Droit de timbre', 'معلوم الطابع', '19 %', '7 %', 'زيت 1 لتر', 'Échéance', 'SO-2026-000001']) {
    assert.ok(html.includes(s), `fehlt: ${s}`);
  }
  assert.match(html, /lang="ar" dir="rtl"/);
});

test('Eingaben werden maskiert (kein HTML aus Kundendaten)', () => {
  const html = renderSalesDocument(invoice);
  assert.ok(html.includes('Épicerie &lt;El Amel&gt;'));
  assert.ok(!html.includes('<El Amel>'));
  assert.equal(escapeHtml(`"'&`), '&quot;&#39;&amp;');
});

test('Lieferschein: ohne Preise und Summen', () => {
  const html = renderSalesDocument({ ...invoice, kind: 'delivery', number: 'BL-2026-000001', totals: undefined, dueDate: null,
    lines: [{ description: 'زيت 1 لتر', quantity: '70.000' }] });
  assert.ok(html.includes('Bon de livraison') && html.includes('وصل تسليم'));
  assert.equal(attr(html, 'data-total-gross'), undefined);
  assert.ok(!html.includes('Prix unitaire'));
});

test('Gutschrift: eigener Titel', () => {
  const html = renderSalesDocument({ ...invoice, kind: 'credit_note', number: 'AV-2026-000001' });
  assert.ok(html.includes('Facture d’avoir'));
});
