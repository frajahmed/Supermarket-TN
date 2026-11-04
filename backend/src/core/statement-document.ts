/**
 * Kontoauszug (relevé de compte) – zweisprachig Französisch/Arabisch, HTML für Druck/PDF (T-114).
 * Gleiches Prinzip wie sales-document.ts: Rohwerte als data-Attribute, damit Tests die Summen prüfen.
 */
import { escapeHtml, formatMinor } from './sales-document.ts';

export type LedgerKind = 'invoice' | 'credit_note' | 'payment' | 'payment_reversal';

export interface StatementEntry {
  date: string; kind: LedgerKind; number: string | null; reference: string | null;
  /** > 0 erhöht die Forderung (Débit), < 0 senkt sie (Crédit); Minor Units */
  amount: string;
  balance: string;
}

export interface StatementInput {
  seller: { name: string; taxId: string | null };
  customer: { name: string; number: string; taxId: string | null };
  from: string | null; to: string;
  currency: string; minorDigits: number;
  opening: string; closing: string;
  entries: StatementEntry[];
}

const KIND: Record<LedgerKind, [string, string]> = {
  invoice: ['Facture', 'فاتورة'],
  credit_note: ['Avoir', 'فاتورة تعديلية'],
  payment: ['Règlement', 'خلاص'],
  payment_reversal: ['Annulation de règlement', 'إلغاء خلاص'],
};
const METHOD: Record<string, string> = {
  cash: 'Espèces', cheque: 'Chèque', transfer: 'Virement', traite: 'Traite', card: 'Carte', other: 'Autre',
};

const both = (fr: string, ar: string) => `${fr}<br><span lang="ar" dir="rtl" class="ar">${ar}</span>`;

/** Summe der Buchungen + Anfangssaldo muss dem Schlusssaldo entsprechen – sonst kein Dokument. */
export function renderStatement(s: StatementInput): string {
  const total = s.entries.reduce((sum, e) => sum + BigInt(e.amount), BigInt(s.opening));
  if (total !== BigInt(s.closing)) throw new Error(`Kontoauszug inkonsistent: ${total} ≠ ${s.closing}`);
  const money = (v: string | bigint) => formatMinor(v, s.minorDigits);
  const rows = s.entries.map((e) => {
    const a = BigInt(e.amount);
    const label = e.kind === 'payment' || e.kind === 'payment_reversal'
      ? `${KIND[e.kind][0]} – ${escapeHtml(METHOD[e.number ?? ''] ?? e.number ?? '')}`
      : `${KIND[e.kind][0]} ${escapeHtml(e.number)}`;
    return `<tr><td>${escapeHtml(e.date)}</td><td>${label}<br><span lang="ar" dir="rtl" class="ar">${KIND[e.kind][1]}</span></td>`
      + `<td>${escapeHtml(e.reference ?? '')}</td>`
      + `<td class="num">${a > 0n ? money(a) : ''}</td><td class="num">${a < 0n ? money(-a) : ''}</td>`
      + `<td class="num" data-balance="${escapeHtml(e.balance)}">${money(e.balance)}</td></tr>`;
  }).join('');
  return `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><title>Relevé de compte ${escapeHtml(s.customer.number)}</title>
<style>
  @page { size: A4; margin: 14mm; }
  body { font: 10.5pt/1.4 "Noto Sans", "Noto Naskh Arabic", Arial, sans-serif; color: #111; margin: 0; }
  .ar { font-family: "Noto Naskh Arabic", Arial, sans-serif; color: #333; }
  header { display: flex; justify-content: space-between; border-bottom: 2px solid #111; padding-bottom: 8px; margin-bottom: 12px; }
  h1 { margin: 0; font-size: 18pt; }
  table { width: 100%; border-collapse: collapse; } th, td { border: 1px solid #bbb; padding: 4px 6px; vertical-align: top; }
  th { background: #f1f1f1; font-size: 9pt; text-align: left; } .num { text-align: right; white-space: nowrap; }
  tr.sum td { font-weight: 700; background: #f1f1f1; }
</style></head><body>
<header>
  <div><h1>${both('Relevé de compte', 'كشف حساب')}</h1>
    <div>${s.from ? `du ${escapeHtml(s.from)} ` : ''}au ${escapeHtml(s.to)}</div></div>
  <div style="text-align:right"><strong>${escapeHtml(s.seller.name)}</strong><br>MF ${escapeHtml(s.seller.taxId ?? '—')}</div>
</header>
<p><strong>${escapeHtml(s.customer.name)}</strong> · ${escapeHtml(s.customer.number)} · MF ${escapeHtml(s.customer.taxId ?? '—')}</p>
<table>
  <tr><th>${both('Date', 'التاريخ')}</th><th>${both('Libellé', 'البيان')}</th><th>${both('Référence', 'المرجع')}</th>
      <th>${both('Débit', 'مدين')}</th><th>${both('Crédit', 'دائن')}</th><th>${both('Solde', 'الرصيد')}</th></tr>
  <tr><td></td><td>${both('Solde initial', 'الرصيد الافتتاحي')}</td><td></td><td></td><td></td>
      <td class="num" data-opening="${escapeHtml(s.opening)}">${money(s.opening)}</td></tr>
  ${rows}
  <tr class="sum"><td></td><td>${both('Solde dû', 'الرصيد المستحق')}</td><td></td><td></td><td></td>
      <td class="num" data-closing="${escapeHtml(s.closing)}">${money(s.closing)} ${escapeHtml(s.currency)}</td></tr>
</table>
</body></html>`;
}
