/**
 * Druckdokumente für Rechnung, Gutschrift und Lieferschein – zweisprachig Französisch/Arabisch.
 *
 * Ausgabe ist HTML (A4, Druck-CSS), nicht direkt PDF: Arabisch braucht Glyphen-Verbindung und
 * Rechts-nach-links-Satz, den PDF-Bibliotheken ohne Browser nicht zuverlässig beherrschen.
 * Browser (Drucken → PDF) und App (expo-print) erzeugen daraus ein korrektes PDF.
 *
 * Jede Summe trägt zusätzlich ein data-Attribut mit dem Rohwert in Minor Units –
 * damit prüft der Test, dass das Dokument exakt die Summen aus sales_invoices zeigt.
 */

export type DocumentKind = 'invoice' | 'credit_note' | 'delivery';

export interface DocumentParty {
  name: string;
  taxId: string | null;
  address?: string | null;
}

export interface DocumentLine {
  description: string;
  quantity: string;             // numeric als Text, z. B. "70.000"
  unitPrice?: string;           // Minor Units (nur Rechnung/Gutschrift)
  discountBp?: number;
  taxRateBp?: number;
  lineNet?: string;             // Minor Units
}

export interface DocumentTotals {
  net: string;
  tax: string;
  stamp: string;
  gross: string;
  breakdown: Array<{ rateBp: number; net: string; tax: string }>;
}

export interface SalesDocumentInput {
  kind: DocumentKind;
  number: string;
  date: string;                 // YYYY-MM-DD
  dueDate?: string | null;
  reference?: string | null;    // z. B. Auftragsnummer oder Bezugsrechnung bei Gutschrift
  currency: string;
  minorDigits: number;          // TND 3, EUR 2
  seller: DocumentParty;
  customer: DocumentParty;
  lines: DocumentLine[];
  totals?: DocumentTotals;      // fehlt beim Lieferschein
}

const TITLES: Record<DocumentKind, [string, string]> = {
  invoice: ['Facture', 'فاتورة'],
  credit_note: ['Facture d’avoir', 'فاتورة تعديلية (إرجاع)'],
  delivery: ['Bon de livraison', 'وصل تسليم'],
};

const L = {
  seller: ['Vendeur', 'البائع'], customer: ['Client', 'الحريف'], taxId: ['Matricule fiscal', 'المعرف الجبائي'],
  date: ['Date', 'التاريخ'], due: ['Échéance', 'تاريخ الاستحقاق'], ref: ['Référence', 'المرجع'],
  description: ['Désignation', 'البيان'], qty: ['Quantité', 'الكمية'], unitPrice: ['Prix unitaire HT', 'سعر الوحدة دون اعتبار الأداءات'],
  discount: ['Remise', 'تخفيض'], vat: ['TVA', 'الأداء على القيمة المضافة'], amount: ['Montant HT', 'المبلغ دون اعتبار الأداءات'],
  base: ['Base HT', 'القاعدة'], net: ['Total HT', 'المجموع دون اعتبار الأداءات'], stamp: ['Droit de timbre', 'معلوم الطابع'],
  gross: ['Total TTC', 'المجموع باعتبار الأداءات'], sign: ['Signature et cachet', 'الإمضاء والختم'],
} as const;

export function escapeHtml(value: string | null | undefined): string {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Minor Units -> "1 234,567" (Leerzeichen als Tausendertrennzeichen, Komma als Dezimaltrennzeichen). */
export function formatMinor(minor: string | bigint, digits: number): string {
  const raw = BigInt(minor);
  const negative = raw < 0n;
  const abs = (negative ? -raw : raw).toString().padStart(digits + 1, '0');
  const whole = abs.slice(0, abs.length - digits).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const frac = digits > 0 ? `,${abs.slice(abs.length - digits)}` : '';
  return `${negative ? '−' : ''}${whole}${frac}`;
}

/** "70.000" -> "70", "2.500" -> "2,5" */
export function formatQuantity(quantity: string): string {
  const [whole, frac = ''] = quantity.split('.');
  const trimmed = frac.replace(/0+$/, '');
  return trimmed ? `${whole},${trimmed}` : whole;
}

const percent = (bp: number) => `${(bp / 100).toLocaleString('fr-FR', { maximumFractionDigits: 2 })} %`;
const both = (pair: readonly [string, string]) =>
  `<span class="fr">${pair[0]}</span><span class="ar" lang="ar" dir="rtl">${pair[1]}</span>`;
/** Einzeilig: "Date · التاريخ" – für Beschriftungen vor einem Wert. */
const inline = (pair: readonly [string, string]) =>
  `<span class="lbl">${pair[0]} · <span lang="ar" dir="rtl">${pair[1]}</span></span>`;

function party(title: readonly [string, string], p: DocumentParty): string {
  return `<div class="party"><h3>${both(title)}</h3>
    <div class="name">${escapeHtml(p.name)}</div>
    ${p.address ? `<div>${escapeHtml(p.address)}</div>` : ''}
    <div>${inline(L.taxId)} <strong>${escapeHtml(p.taxId ?? '—')}</strong></div></div>`;
}

export function renderSalesDocument(doc: SalesDocumentInput): string {
  const money = (v: string | undefined) => (v === undefined ? '' : formatMinor(v, doc.minorDigits));
  const priced = doc.kind !== 'delivery';
  const header = priced
    ? `<tr><th>${both(L.description)}</th><th>${both(L.qty)}</th><th>${both(L.unitPrice)}</th><th>${both(L.discount)}</th><th>${both(L.vat)}</th><th>${both(L.amount)}</th></tr>`
    : `<tr><th>${both(L.description)}</th><th>${both(L.qty)}</th></tr>`;
  const rows = doc.lines.map((l) => priced
    ? `<tr><td>${escapeHtml(l.description)}</td><td class="num">${formatQuantity(l.quantity)}</td><td class="num">${money(l.unitPrice)}</td>`
      + `<td class="num">${l.discountBp ? percent(l.discountBp) : ''}</td><td class="num">${percent(l.taxRateBp ?? 0)}</td>`
      + `<td class="num" data-line-net="${escapeHtml(l.lineNet ?? '')}">${money(l.lineNet)}</td></tr>`
    : `<tr><td>${escapeHtml(l.description)}</td><td class="num">${formatQuantity(l.quantity)}</td></tr>`).join('');

  const t = doc.totals;
  const totals = t ? `
    <table class="totals">
      ${t.breakdown.map((b) => `<tr class="vat"><td>${inline(L.vat)} ${percent(b.rateBp)} <small>(${L.base[0]} ${money(b.net)})</small></td>
        <td class="num" data-tax-rate="${b.rateBp}" data-tax="${escapeHtml(b.tax)}">${money(b.tax)}</td></tr>`).join('')}
      <tr><td>${inline(L.net)}</td><td class="num" data-total-net="${escapeHtml(t.net)}">${money(t.net)}</td></tr>
      <tr><td>${inline(L.vat)}</td><td class="num" data-total-tax="${escapeHtml(t.tax)}">${money(t.tax)}</td></tr>
      <tr><td>${inline(L.stamp)}</td><td class="num" data-total-stamp="${escapeHtml(t.stamp)}">${money(t.stamp)}</td></tr>
      <tr class="grand"><td>${inline(L.gross)}</td><td class="num" data-total-gross="${escapeHtml(t.gross)}">${money(t.gross)} ${escapeHtml(doc.currency)}</td></tr>
    </table>` : '';

  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8">
<title>${escapeHtml(TITLES[doc.kind][0])} ${escapeHtml(doc.number)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font: 11pt/1.4 "Noto Sans", "Noto Naskh Arabic", Arial, sans-serif; color: #111; margin: 0; }
  .ar { font-family: "Noto Naskh Arabic", "Arial", sans-serif; display: block; font-size: 0.95em; color: #333; }
  .fr { display: block; }
  header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2px solid #111; padding-bottom: 8px; }
  h1 { margin: 0; font-size: 20pt; } h1 .ar { font-size: 15pt; }
  .meta { text-align: right; } .meta div { margin: 2px 0; }
  .parties { display: flex; gap: 24px; margin: 16px 0; } .party { flex: 1; border: 1px solid #bbb; padding: 8px; border-radius: 4px; }
  .party h3 { margin: 0 0 4px; font-size: 10pt; color: #555; } .party .name { font-weight: 700; font-size: 12pt; }
  table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #bbb; padding: 4px 6px; vertical-align: top; }
  th { background: #f1f1f1; font-size: 9pt; text-align: left; } .num { text-align: right; white-space: nowrap; }
  .totals { width: 60%; margin: 12px 0 0 auto; } .totals .grand td { font-weight: 700; font-size: 12pt; background: #f1f1f1; }
  .lbl { color: #444; } .lbl [lang=ar] { font-family: "Noto Naskh Arabic", Arial, sans-serif; }
  .vat td { font-size: 9.5pt; color: #444; } .meta .lbl { margin-right: 4px; }
  .sign { margin-top: 40px; width: 40%; margin-left: auto; border-top: 1px solid #111; padding-top: 4px; text-align: center; }
</style></head>
<body data-document-kind="${doc.kind}" data-document-number="${escapeHtml(doc.number)}">
<header>
  <h1>${both(TITLES[doc.kind])}</h1>
  <div class="meta">
    <div><strong>${escapeHtml(doc.number)}</strong></div>
    <div>${inline(L.date)} ${escapeHtml(doc.date)}</div>
    ${doc.dueDate ? `<div>${inline(L.due)} ${escapeHtml(doc.dueDate)}</div>` : ''}
    ${doc.reference ? `<div>${inline(L.ref)} ${escapeHtml(doc.reference)}</div>` : ''}
  </div>
</header>
<section class="parties">${party(L.seller, doc.seller)}${party(L.customer, doc.customer)}</section>
<table class="lines"><thead>${header}</thead><tbody>${rows}</tbody></table>
${totals}
<div class="sign">${both(L.sign)}</div>
</body></html>`;
}
