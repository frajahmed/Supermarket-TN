/**
 * Zahlungen und Kontoauszug in der App (T-114) – reine Logik, mit Node getestet.
 */
import { parseMoneyInput } from './products.ts';
import { parseDateInput } from './warehouse.ts';

export const PAYMENT_METHODS = ['cash', 'cheque', 'transfer', 'traite', 'card', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export interface PaymentForm { amount: string; method: PaymentMethod; reference: string; receivedAt: string; invoiceId: string | null }
export type PaymentError = 'invalidAmount' | 'referenceRequired' | 'invalidDate' | 'futureDate';

/** Formular → Body für POST /customers/:id/payments (ohne clientOpId; die setzt sendOnce). */
export function paymentBody(f: PaymentForm, today: string):
  { ok: true; body: Record<string, string> } | { ok: false; errors: Partial<Record<keyof PaymentForm, PaymentError>> } {
  const errors: Partial<Record<keyof PaymentForm, PaymentError>> = {};
  const amount = parseMoneyInput(f.amount);
  if (amount === null || amount === '0') errors.amount = 'invalidAmount';
  if ((f.method === 'cheque' || f.method === 'traite') && !f.reference.trim()) errors.reference = 'referenceRequired';
  let date: string | null = null;
  if (f.receivedAt.trim()) {
    date = parseDateInput(f.receivedAt);
    if (!date) errors.receivedAt = 'invalidDate';
    else if (date > today) errors.receivedAt = 'futureDate';
  }
  if (Object.keys(errors).length) return { ok: false, errors };
  const body: Record<string, string> = { amount: amount!, method: f.method };
  if (f.reference.trim()) body.reference = f.reference.trim();
  if (date) body.receivedAt = date;
  if (f.invoiceId) body.invoiceId = f.invoiceId;
  return { ok: true, body };
}

export type LedgerKind = 'invoice' | 'credit_note' | 'payment' | 'payment_reversal';

export interface StatementEntry {
  date: string; kind: LedgerKind; documentId: string; number: string | null; reference: string | null;
  amount: string; balance: string; reversed: boolean;
}

export interface Statement {
  customer: { id: string; name: string; number: string; openBalance: string };
  from: string | null; to: string; opening: string; closing: string; entries: StatementEntry[];
}

/** Débit (Forderung steigt) / Crédit (sinkt) – Beträge ohne Vorzeichen für die Anzeige. */
export function debitCredit(amount: string): { debit: string | null; credit: string | null } {
  return amount.startsWith('-') ? { debit: null, credit: amount.slice(1) } : { debit: amount, credit: null };
}

/** Prüft, dass Anfangssaldo + Buchungen = Schlusssaldo und der laufende Saldo stimmt. */
export function statementConsistent(s: Statement): boolean {
  let b = BigInt(s.opening);
  for (const e of s.entries) {
    b += BigInt(e.amount);
    if (b !== BigInt(e.balance)) return false;
  }
  return b === BigInt(s.closing);
}

/** Erster Tag des Monats vor `today` – sinnvoller Standardzeitraum für den Auszug. */
export function defaultStatementFrom(today: string): string {
  const [y, m] = today.split('-').map(Number) as [number, number];
  const py = m === 1 ? y - 1 : y;
  const pm = m === 1 ? 12 : m - 1;
  return `${py}-${String(pm).padStart(2, '0')}-01`;
}

export function canReverse(p: { reversesPaymentId: string | null; reversed: boolean }): boolean {
  return p.reversesPaymentId === null && !p.reversed;
}
