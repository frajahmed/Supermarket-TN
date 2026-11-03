/**
 * Lager in der App (T-113): Wareneingang, Inventur, Verlust – Bewegungen für POST /sync/push.
 * Reine Logik, mit Node getestet. Mengen exakt in Tausendsteln.
 */
import { ApiError } from './api-client.ts';
import { fromMilli, isQuantity, toMilli, type KeyValueStore } from './orders.ts';

export interface Movement {
  clientOpId: string; storeId: string; productId: string; type: string; quantityDelta: string; occurredAt: string;
  lotId?: string; lot?: { lotNumber?: string; expiryDate: string }; reason?: string; refType?: string;
}

export type WarehouseError = 'invalidQuantity' | 'wholePackagesOnly' | 'invalidDate' | 'expiryRequired' | 'reasonRequired'
  | 'nothingCounted';

export function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** „31/12/2027“ oder „31.12.2027“ (wie auf der Packung) → „2027-12-31“. */
export function parseDateInput(input: string): string | null {
  const v = input.trim();
  if (isIsoDate(v)) return v;
  const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/u.exec(v);
  if (!m) return null;
  const iso = `${m[3]}-${m[2]!.padStart(2, '0')}-${m[1]!.padStart(2, '0')}`;
  return isIsoDate(iso) ? iso : null;
}

/** Wareneingang: Gebinde × Faktor = Basismenge; MHD Pflicht, wenn das Produkt es verlangt. */
export function receiptMovement(i: {
  storeId: string; productId: string; packs: string; factor: string; packaged: boolean; trackExpiry: boolean;
  expiry: string; lotNumber: string; clientOpId: string; now: Date;
}): { ok: true; movement: Movement } | { ok: false; error: WarehouseError } {
  const packs = i.packs.trim().replace(',', '.');
  if (!isQuantity(packs)) return { ok: false, error: 'invalidQuantity' };
  if (i.packaged && !/^\d+$/u.test(packs)) return { ok: false, error: 'wholePackagesOnly' };
  const qty = (toMilli(packs) * toMilli(i.factor)) / 1000n;
  const movement: Movement = {
    clientOpId: i.clientOpId, storeId: i.storeId, productId: i.productId, type: 'purchase_receipt',
    quantityDelta: fromMilli(qty), occurredAt: i.now.toISOString(),
  };
  if (i.expiry.trim()) {
    const date = parseDateInput(i.expiry);
    if (!date) return { ok: false, error: 'invalidDate' };
    movement.lot = { expiryDate: date, ...(i.lotNumber.trim() ? { lotNumber: i.lotNumber.trim() } : {}) };
  } else if (i.trackExpiry) {
    return { ok: false, error: 'expiryRequired' };
  }
  return { ok: true, movement };
}

export interface CountEntry { productId: string; expected: string; counted: string }

/**
 * Inventur: Differenz = gezählt − Bestand laut System, gebucht als `inventory_count` mit Vorzeichen.
 * Nicht gezählte Positionen (leer) und Positionen ohne Differenz entfallen.
 */
export function countMovements(storeId: string, entries: CountEntry[], newId: () => string, now: Date):
  { ok: true; movements: Movement[]; counted: number } | { ok: false; error: WarehouseError; productId?: string } {
  const movements: Movement[] = [];
  let counted = 0;
  for (const e of entries) {
    const raw = e.counted.trim().replace(',', '.');
    if (!raw) continue;
    if (!/^\d{1,11}(\.\d{1,3})?$/u.test(raw)) return { ok: false, error: 'invalidQuantity', productId: e.productId };
    counted++;
    const delta = toMilli(raw) - toMilli(e.expected);
    if (delta === 0n) continue;
    movements.push({ clientOpId: newId(), storeId, productId: e.productId, type: 'inventory_count',
      quantityDelta: fromMilli(delta), refType: 'count', occurredAt: now.toISOString() });
  }
  return counted ? { ok: true, movements, counted } : { ok: false, error: 'nothingCounted' };
}

export const LOSS_REASONS = ['expired', 'damaged', 'theft', 'other'] as const;
export type LossReason = (typeof LOSS_REASONS)[number];

/** Verlust: Begründung Pflicht (wie der Server); „Sonstiges“ verlangt einen Freitext. */
export function lossMovement(i: {
  storeId: string; productId: string; quantity: string; reason: LossReason | null; note: string; lotId?: string;
  clientOpId: string; now: Date;
}): { ok: true; movement: Movement } | { ok: false; error: WarehouseError } {
  const q = i.quantity.trim().replace(',', '.');
  if (!isQuantity(q)) return { ok: false, error: 'invalidQuantity' };
  const note = i.note.trim();
  if (!i.reason || (i.reason === 'other' && !note)) return { ok: false, error: 'reasonRequired' };
  return { ok: true, movement: {
    clientOpId: i.clientOpId, storeId: i.storeId, productId: i.productId, type: 'loss',
    quantityDelta: fromMilli(-toMilli(q)), reason: note ? `${i.reason}: ${note}` : i.reason, occurredAt: i.now.toISOString(),
    ...(i.lotId ? { lotId: i.lotId } : {}),
  } };
}

export interface PushResult { clientOpId: string; status: 'accepted' | 'duplicate' | 'rejected'; error?: string }

export function summarize(results: PushResult[]) {
  return {
    booked: results.filter((r) => r.status !== 'rejected').length,
    rejected: results.filter((r) => r.status === 'rejected').map((r) => ({ clientOpId: r.clientOpId, error: r.error ?? '' })),
  };
}

/**
 * Stapel genau einmal senden: Die Bewegungen (mit ihren clientOpIds) werden VOR dem Senden
 * gespeichert. Nach Netzabbruch sendet ein erneuter Versuch mit gleichem Inhalt dieselben
 * Bewegungen – der Server meldet sie dann als „duplicate“ statt doppelt zu buchen.
 */
export async function pushOnce(store: KeyValueStore, intent: string, content: unknown, build: () => Movement[],
  send: (movements: Movement[]) => Promise<PushResult[]>): Promise<PushResult[]> {
  const key = `stn.pending-push.${intent}`;
  const fingerprint = JSON.stringify(content);
  let movements: Movement[] | null = null;
  const saved = await store.getItemAsync(key);
  if (saved) {
    try {
      const p = JSON.parse(saved) as { fingerprint?: unknown; movements?: Movement[] };
      if (p.fingerprint === fingerprint && Array.isArray(p.movements)) movements = p.movements;
    } catch { /* neu bauen */ }
  }
  if (!movements) {
    movements = build();
    await store.setItemAsync(key, JSON.stringify({ fingerprint, movements }));
  }
  try {
    const results = await send(movements);
    await store.deleteItemAsync(key);
    return results;
  } catch (e) {
    if (e instanceof ApiError && e.status >= 400 && e.status < 500) await store.deleteItemAsync(key);
    throw e;
  }
}

export interface StockAlerts {
  lowStock: Array<{ productId: string; sku: string; name: string; quantity: string; minStock: string }>;
  expiringSoon: Array<{ productId: string; sku: string; name: string; lotNumber: string | null; expiryDate: string; daysLeft: number; quantity: string }>;
}
