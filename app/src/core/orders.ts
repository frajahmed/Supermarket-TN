import { ApiError } from './api-client.ts';
import type { LocalizedName } from './products.ts';

export function toMilli(value: string): bigint {
  const m = /^(-)?(\d+)(?:\.(\d{1,3}))?$/u.exec(value.trim());
  if (!m || m[2] === undefined) throw new Error(`Ungültige Menge: ${value}`);
  const v = BigInt(m[2]) * 1000n + BigInt((m[3] ?? '').padEnd(3, '0'));
  return m[1] ? -v : v;
}

export function fromMilli(v: bigint): string {
  const sign = v < 0n ? '-' : '';
  const a = v < 0n ? -v : v;
  const frac = String(a % 1000n).padStart(3, '0').replace(/0+$/u, '');
  return `${sign}${a / 1000n}${frac ? `.${frac}` : ''}`;
}

export function isQuantity(value: string): boolean {
  return /^\d{1,11}(\.\d{1,3})?$/u.test(value.trim()) && /[1-9]/u.test(value);
}

export interface DraftLine {
  key: string;
  productId: string;
  label: string;
  unit: string;
  packagingId?: string;
  packagingLabel?: string;
  /** Basiseinheiten je Gebinde ("12"); ohne Gebinde "1" */
  factor: string;
  /** Eingabe in Gebinden (mit Gebinde nur ganze Zahl) bzw. Basiseinheiten */
  quantity: string;
}

export function addToDraft(lines: DraftLine[], item: Omit<DraftLine, 'key' | 'quantity'>, quantity = '1'): DraftLine[] {
  const key = item.packagingId ? `${item.productId}:${item.packagingId}` : item.productId;
  const existing = lines.find((l) => l.key === key);
  if (existing) {
    return lines.map((l) => (l.key === key ? { ...l, quantity: fromMilli(toMilli(l.quantity) + toMilli(quantity)) } : l));
  }
  return [...lines, { ...item, key, quantity }];
}

export function baseQuantity(line: DraftLine): string {
  return fromMilli((toMilli(line.quantity) * toMilli(line.factor)) / 1000n);
}

export type DraftError = 'noCustomer' | 'noLines' | 'invalidQuantity' | 'wholePackagesOnly';

export function orderBody(input: { storeId: string; customerId: string | null; lines: DraftLine[]; note?: string },
  clientOpId: string): { ok: true; body: Record<string, unknown> } | { ok: false; error: DraftError; lineKey?: string } {
  if (!input.customerId) return { ok: false, error: 'noCustomer' };
  if (input.lines.length === 0) return { ok: false, error: 'noLines' };
  for (const l of input.lines) {
    if (!isQuantity(l.quantity)) return { ok: false, error: 'invalidQuantity', lineKey: l.key };
    if (l.packagingId && !/^\d+$/u.test(l.quantity.trim())) return { ok: false, error: 'wholePackagesOnly', lineKey: l.key };
  }
  const body: Record<string, unknown> = {
    storeId: input.storeId, customerId: input.customerId, clientOpId,
    lines: input.lines.map((l) => ({ productId: l.productId, quantity: baseQuantity(l), ...(l.packagingId ? { packagingId: l.packagingId } : {}) })),
  };
  if (input.note?.trim()) body.note = input.note.trim();
  return { ok: true, body };
}

export interface OrderLine {
  id: string; lineNo: number; productId: string; sku: string; productName: LocalizedName; unit: string;
  packagingId: string | null; packagingName: LocalizedName | null; packagingFactor: string | null;
  quantity: string; quantityDelivered: string; unitPrice: string; discountBp: number; taxRateBp: number;
}

export interface Order {
  id: string; number: string; status: 'draft' | 'confirmed' | 'delivered' | 'invoiced' | 'cancelled';
  storeId: string; customerId: string; customerName: string; currency: string; estimatedGross: string;
  requestedDate: string | null; note: string | null; creditOverrideReason: string | null;
  lines: OrderLine[];
  deliveries: Array<{ id: string; number: string; invoiceId: string | null; deliveredAt: string }>;
}

export function remaining(line: OrderLine): string {
  const r = toMilli(line.quantity) - toMilli(line.quantityDelivered);
  return fromMilli(r > 0n ? r : 0n);
}

export function canDeliver(order: Order): boolean {
  return order.status === 'confirmed' && order.lines.some((l) => toMilli(remaining(l)) > 0n);
}

export function initialPick(order: Order): Record<string, string> {
  return Object.fromEntries(order.lines.map((l) => [l.id, remaining(l)]));
}

export type PickError = 'notInOrder' | 'exceedsRemaining';

export function applyScan(order: Order, pick: Record<string, string>, productId: string, perScan: string, fromZero: Set<string>):
  { ok: true; pick: Record<string, string>; lineId: string } | { ok: false; error: PickError } {
  const lines = order.lines.filter((l) => l.productId === productId);
  if (!lines.length) return { ok: false, error: 'notInOrder' };
  for (const l of lines) {
    // Erster Scan einer Position zählt von 0 (statt von der vorbelegten Restmenge)
    const current = fromZero.has(l.id) ? toMilli(pick[l.id] ?? '0') : 0n;
    const next = current + toMilli(perScan);
    if (next <= toMilli(remaining(l))) {
      fromZero.add(l.id);
      return { ok: true, pick: { ...pick, [l.id]: fromMilli(next) }, lineId: l.id };
    }
  }
  return { ok: false, error: 'exceedsRemaining' };
}

export function deliveryBody(order: Order, pick: Record<string, string>, clientOpId: string):
  { ok: true; body: { clientOpId: string; lines: Array<{ orderLineId: string; quantity: string }> } }
  | { ok: false; error: 'nothingToDeliver' | 'invalidQuantity' | 'exceedsRemaining'; lineId?: string } {
  const lines: Array<{ orderLineId: string; quantity: string }> = [];
  for (const l of order.lines) {
    const raw = (pick[l.id] ?? '').trim().replace(',', '.');
    if (!raw || /^0+(\.0+)?$/u.test(raw)) continue;
    if (!isQuantity(raw)) return { ok: false, error: 'invalidQuantity', lineId: l.id };
    if (toMilli(raw) > toMilli(remaining(l))) return { ok: false, error: 'exceedsRemaining', lineId: l.id };
    lines.push({ orderLineId: l.id, quantity: fromMilli(toMilli(raw)) });
  }
  return lines.length ? { ok: true, body: { clientOpId, lines } } : { ok: false, error: 'nothingToDeliver' };
}

export interface CreditLimitInfo { open: string; order: string; limit: string; canOverride: boolean }

export function creditLimitInfo(e: unknown): CreditLimitInfo | null {
  if (!(e instanceof ApiError) || e.status !== 409) return null;
  const b = e.body as Partial<CreditLimitInfo> & { code?: string };
  if (b.code !== 'CREDIT_LIMIT' || typeof b.open !== 'string' || typeof b.order !== 'string' || typeof b.limit !== 'string') return null;
  return { open: b.open, order: b.order, limit: b.limit, canOverride: b.canOverride === true };
}

export interface KeyValueStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

// Die ID wird vor dem Senden gespeichert und bei gleichem Inhalt wiederverwendet, damit nach Netzabbruch nichts doppelt gebucht wird.
// Anderer Inhalt bekommt eine neue ID, sonst gäbe der Server still den alten Vorgang zurück.
export async function sendOnce<T>(store: KeyValueStore, intent: string, content: unknown, newId: () => string,
  send: (clientOpId: string) => Promise<T>): Promise<T> {
  const key = `stn.pending-op.${intent}`;
  const fingerprint = JSON.stringify(content);
  let id: string | null = null;
  const saved = await store.getItemAsync(key);
  if (saved) {
    try {
      const p = JSON.parse(saved) as { id?: unknown; fingerprint?: unknown };
      if (typeof p.id === 'string' && p.fingerprint === fingerprint) id = p.id;
    } catch { /* unlesbar -> neue ID */ }
  }
  if (!id) {
    id = newId();
    await store.setItemAsync(key, JSON.stringify({ id, fingerprint }));
  }
  try {
    const result = await send(id);
    await store.deleteItemAsync(key);
    return result;
  } catch (e) {
    if (e instanceof ApiError && e.status >= 400 && e.status < 500) await store.deleteItemAsync(key);
    throw e;
  }
}

export type DocumentKind = 'invoice' | 'delivery' | 'statement' | 'receipt';

/** Für 'statement' ist `id` die Kunden-ID; `query` z. B. "from=2026-10-01". */
export function documentPath(kind: DocumentKind, id: string, query = ''): string {
  if (kind === 'statement') return `/api/v1/customers/${id}/statement/document${query ? `?${query}` : ''}`;
  if (kind === 'receipt') return `/api/v1/pos/sales/${id}/receipt`;
  return kind === 'invoice' ? `/api/v1/invoices/${id}/document` : `/api/v1/deliveries/${id}/document`;
}

export function documentFileName(number: string): string {
  return `${number.replace(/[^A-Za-z0-9._-]/gu, '_')}.pdf`;
}
