// Prüfungen spiegeln backend/src/customers/customers.dto.ts; der Server prüft trotzdem.
import { moneyInputFromMinor, parseMoneyInput } from './products.ts';

export type CustomerType = 'business' | 'individual';
export type CustomerLocale = 'fr-TN' | 'ar-TN' | 'en';

export interface Customer {
  id: string; number: string; type: CustomerType; name: string; legalName: string | null; taxId: string | null;
  vatExempt: boolean; paymentTermsDays: number; creditLimit: string | null; phone: string | null; email: string | null;
  billingAddress: { street?: string; city?: string; postalCode?: string; governorate?: string };
  preferredLocale: CustomerLocale; isActive: boolean; openBalance: string; overLimit: boolean;
}

export interface CustomerDetail {
  customer: Customer;
  groupName: Record<string, string> | null;
  recentOrders: Array<{ id: string; number: string; status: string; createdAt: string; grossTotal: string }>;
  recentInvoices: Array<{ id: string; number: string; status: string; isCreditNote: boolean; issueDate: string | null;
    dueDate: string | null; grossTotal: string }>;
  recentPayments: Array<{ id: string; amount: string; method: string; reference: string | null; receivedAt: string;
    reversesPaymentId: string | null; reason: string | null; reversed: boolean }>;
}

export function normalizeTaxId(value: string): string {
  return value.replace(/\s+/gu, '').toUpperCase();
}

export function isValidTaxId(value: string): boolean {
  return /^\d{7}[A-Z](?:[/.-]?[A-Z0-9]{1,3}){0,4}$/u.test(value);
}

export interface CustomerForm {
  type: CustomerType; name: string; legalName: string; taxId: string; phone: string; email: string;
  street: string; city: string; postalCode: string; governorate: string;
  paymentTermsDays: string; creditLimit: string; vatExempt: boolean; preferredLocale: CustomerLocale;
}

export type CustomerFormError = 'nameRequired' | 'taxIdRequired' | 'taxIdInvalid' | 'invalidEmail' | 'invalidDays'
  | 'invalidPrice' | 'numberTaken';

export const EMPTY_CUSTOMER_FORM: CustomerForm = {
  type: 'business', name: '', legalName: '', taxId: '', phone: '', email: '', street: '', city: '', postalCode: '',
  governorate: '', paymentTermsDays: '0', creditLimit: '', vatExempt: false, preferredLocale: 'fr-TN',
};

export function formFromCustomer(c: Customer): CustomerForm {
  return {
    type: c.type, name: c.name, legalName: c.legalName ?? '', taxId: c.taxId ?? '', phone: c.phone ?? '', email: c.email ?? '',
    street: c.billingAddress.street ?? '', city: c.billingAddress.city ?? '', postalCode: c.billingAddress.postalCode ?? '',
    governorate: c.billingAddress.governorate ?? '', paymentTermsDays: String(c.paymentTermsDays),
    creditLimit: moneyInputFromMinor(c.creditLimit), vatExempt: c.vatExempt, preferredLocale: c.preferredLocale,
  };
}

const orNull = (v: string) => (v.trim() ? v.trim() : null);

// Leeres Kreditlimit bedeutet: kein Limit (null).
export function customerBodyFromForm(f: CustomerForm, opts: { canEditCredit: boolean }):
  { ok: true; body: Record<string, unknown> } | { ok: false; errors: Partial<Record<keyof CustomerForm, CustomerFormError>> } {
  const errors: Partial<Record<keyof CustomerForm, CustomerFormError>> = {};
  if (!f.name.trim()) errors.name = 'nameRequired';
  const taxId = normalizeTaxId(f.taxId);
  if (taxId && !isValidTaxId(taxId)) errors.taxId = 'taxIdInvalid';
  else if (f.type === 'business' && !taxId) errors.taxId = 'taxIdRequired';
  if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(f.email.trim())) errors.email = 'invalidEmail';

  const address: Record<string, string> = {};
  for (const k of ['street', 'city', 'postalCode', 'governorate'] as const) if (f[k].trim()) address[k] = f[k].trim();
  const body: Record<string, unknown> = {
    type: f.type, name: f.name.trim(), legalName: orNull(f.legalName), taxId: taxId || null,
    phone: orNull(f.phone), email: orNull(f.email), billingAddress: address, vatExempt: f.vatExempt,
    preferredLocale: f.preferredLocale,
  };
  if (opts.canEditCredit) {
    const days = Number(f.paymentTermsDays || '0');
    if (!/^\d{1,3}$/u.test(f.paymentTermsDays || '0') || days > 365) errors.paymentTermsDays = 'invalidDays';
    else body.paymentTermsDays = days;
    if (!f.creditLimit.trim()) body.creditLimit = null;
    else {
      const minor = parseMoneyInput(f.creditLimit);
      if (minor === null) errors.creditLimit = 'invalidPrice'; else body.creditLimit = minor;
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, body };
}

export function fieldErrorsFromServer(body: unknown): Partial<Record<keyof CustomerForm, CustomerFormError>> {
  const issues = (body as { issues?: Array<{ path?: unknown[] }> } | null)?.issues ?? [];
  const out: Partial<Record<keyof CustomerForm, CustomerFormError>> = {};
  for (const i of issues) {
    const field = i.path?.[0];
    if (field === 'taxId') out.taxId = 'taxIdInvalid';
    else if (field === 'name') out.name = 'nameRequired';
    else if (field === 'email') out.email = 'invalidEmail';
    else if (field === 'creditLimit') out.creditLimit = 'invalidPrice';
    else if (field === 'paymentTermsDays') out.paymentTermsDays = 'invalidDays';
  }
  return out;
}

export type CreditState = 'none' | 'ok' | 'near' | 'over';

/** „near“ ab 80 % Auslastung des Kreditlimits. */
export function creditState(openBalance: string, creditLimit: string | null): CreditState {
  if (creditLimit === null) return 'none';
  const open = BigInt(openBalance), limit = BigInt(creditLimit);
  if (open > limit) return 'over';
  return open * 10n >= limit * 8n && limit > 0n ? 'near' : 'ok';
}

export function availableCredit(openBalance: string, creditLimit: string | null): string | null {
  if (creditLimit === null) return null;
  const rest = BigInt(creditLimit) - BigInt(openBalance);
  return String(rest > 0n ? rest : 0n);
}
