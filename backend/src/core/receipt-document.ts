/**
 * Kassenbon (80 mm) – zweisprachig Französisch/Arabisch, HTML für expo-print bzw. später ESC/POS (T-115).
 */
import { escapeHtml, formatMinor, formatQuantity } from './sales-document.ts';

export interface ReceiptInput {
  seller: { name: string; taxId: string | null; store: string };
  receiptNumber: string; deviceName: string; cashier: string; completedAt: Date | string | null;
  voidsReceiptNumber: string | null; voidReason: string | null;
  lines: Array<{ productName: string; quantity: string; unitPrice: string; discount: string; taxRateBp: number; lineTotal: string }>;
  payments: Array<{ method: string; amount: string }>;
  totals: { gross: string; tax: string; net: string; discount: string };
}

const METHOD: Record<string, [string, string]> = {
  cash: ['Espèces', 'نقدًا'], card: ['Carte', 'بطاقة'], voucher: ['Bon d’achat', 'قسيمة'], other: ['Autre', 'أخرى'],
};

export function renderReceipt(r: ReceiptInput): string {
  const m = (v: string) => formatMinor(v, 3);
  const when = r.completedAt ? new Date(r.completedAt).toISOString().slice(0, 16).replace('T', ' ') : '';
  const lines = r.lines.map((l) => `<tr><td colspan="2">${escapeHtml(l.productName)}</td></tr>
    <tr><td>${formatQuantity(l.quantity.replace(/^-/u, ''))} × ${m(l.unitPrice)}${BigInt(l.discount) !== 0n ? ` − ${m(l.discount.replace(/^-/u, ''))}` : ''}</td>
        <td class="num" data-line-total="${escapeHtml(l.lineTotal)}">${m(l.lineTotal)}</td></tr>`).join('');
  const pays = r.payments.map((p) => `<tr><td>${METHOD[p.method]?.[0] ?? escapeHtml(p.method)} · <span lang="ar">${METHOD[p.method]?.[1] ?? ''}</span></td>
    <td class="num">${m(p.amount)}</td></tr>`).join('');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Ticket ${escapeHtml(r.receiptNumber)}</title>
<style>
  @page { size: 80mm auto; margin: 3mm; }
  body { font: 10pt/1.35 "Noto Sans", "Noto Naskh Arabic", Arial, sans-serif; width: 74mm; margin: 0 auto; color: #000; }
  h1 { font-size: 12pt; text-align: center; margin: 0; } .c { text-align: center; } [lang=ar] { font-family: "Noto Naskh Arabic", Arial, sans-serif; }
  table { width: 100%; border-collapse: collapse; } td { padding: 1px 0; vertical-align: top; } .num { text-align: right; white-space: nowrap; }
  .sep { border-top: 1px dashed #000; margin: 4px 0; } .big td { font-size: 12pt; font-weight: 700; } .void { font-weight: 700; text-align: center; border: 1px solid #000; padding: 2px; }
</style></head><body>
<h1>${escapeHtml(r.seller.name)}</h1>
<div class="c">${escapeHtml(r.seller.store)}${r.seller.taxId ? `<br>MF ${escapeHtml(r.seller.taxId)}` : ''}</div>
<div class="sep"></div>
<div>Ticket · <span lang="ar">تذكرة</span> <strong>N° ${escapeHtml(r.receiptNumber)}</strong> · ${escapeHtml(r.deviceName)}</div>
<div>${escapeHtml(when)} UTC · ${escapeHtml(r.cashier)}</div>
${r.voidsReceiptNumber ? `<div class="void">ANNULATION du ticket N° ${escapeHtml(r.voidsReceiptNumber)} · <span lang="ar">إلغاء</span><br>${escapeHtml(r.voidReason)}</div>` : ''}
<div class="sep"></div>
<table>${lines}</table>
<div class="sep"></div>
<table>
  ${BigInt(r.totals.discount) !== 0n ? `<tr><td>Remise · <span lang="ar">تخفيض</span></td><td class="num">${m(r.totals.discount)}</td></tr>` : ''}
  <tr class="big"><td>TOTAL TTC · <span lang="ar">المجموع</span></td><td class="num" data-total-gross="${escapeHtml(r.totals.gross)}">${m(r.totals.gross)} TND</td></tr>
  <tr><td>dont TVA · <span lang="ar">منها الأداء</span></td><td class="num" data-total-tax="${escapeHtml(r.totals.tax)}">${m(r.totals.tax)}</td></tr>
  <tr><td>Total HT</td><td class="num">${m(r.totals.net)}</td></tr>
</table>
<div class="sep"></div>
<table>${pays}</table>
<div class="sep"></div>
<div class="c">Merci de votre visite · <span lang="ar">شكرا لزيارتكم</span></div>
</body></html>`;
}
