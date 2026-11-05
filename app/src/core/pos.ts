import { fromMilli, isQuantity, toMilli } from './orders.ts';

export interface CartLine {
  productId: string; label: string; unit: string;
  /** Bruttopreis je Basiseinheit in Millimes (Filialpreis) */
  unitPrice: string;
  quantity: string;
  discountBp: number;
}

export function addToCart(cart: CartLine[], item: Omit<CartLine, 'quantity' | 'discountBp'>, quantity = '1'): CartLine[] {
  const existing = cart.find((l) => l.productId === item.productId);
  if (existing) {
    return cart.map((l) => (l.productId === item.productId ? { ...l, quantity: fromMilli(toMilli(l.quantity) + toMilli(quantity)) } : l));
  }
  return [...cart, { ...item, quantity, discountBp: 0 }];
}

/** Half-up wie PostgreSQL round(numeric) – die Vorschau muss exakt dem Bon entsprechen. */
function divRound(a: bigint, b: bigint): bigint {
  return a >= 0n ? (2n * a + b) / (2n * b) : -((2n * -a + b) / (2n * b));
}

export function lineAmounts(l: CartLine): { gross: bigint; discount: bigint; total: bigint } {
  const gross = divRound(toMilli(l.quantity) * BigInt(l.unitPrice), 1000n);
  const discount = divRound(gross * BigInt(l.discountBp), 10000n);
  return { gross, discount, total: gross - discount };
}

export function cartTotals(cart: CartLine[]): { total: string; discount: string; items: number } {
  let total = 0n, discount = 0n;
  for (const l of cart) {
    const a = lineAmounts(l);
    total += a.total; discount += a.discount;
  }
  return { total: total.toString(), discount: discount.toString(), items: cart.length };
}

export function parsePercent(input: string): number | null {
  const v = input.trim().replace(',', '.');
  if (!v) return 0;
  if (!/^\d{1,3}(\.\d{1,2})?$/u.test(v)) return null;
  const bp = Math.round(Number(v) * 100);
  return bp <= 10000 ? bp : null;
}

export function needsApproval(cart: CartLine[], limitBp: number, canApprove: boolean): boolean {
  return !canApprove && cart.some((l) => l.discountBp > limitBp);
}

export type PayError = 'emptyCart' | 'invalidQuantity' | 'invalidAmount' | 'notEnough' | 'cardTooHigh';

// Rückgeld nur aus Bargeld; die Karte darf den Bonbetrag nicht übersteigen.
export function planPayment(totalMinor: string, cashInput: string, cardInput: string, parse: (s: string) => string | null):
  { ok: true; payments: Array<{ method: 'cash' | 'card'; amount: string }>; change: string } | { ok: false; error: PayError } {
  const total = BigInt(totalMinor);
  const cash = cashInput.trim() ? parse(cashInput) : '0';
  const card = cardInput.trim() ? parse(cardInput) : '0';
  if (cash === null || card === null) return { ok: false, error: 'invalidAmount' };
  const c = BigInt(cash), k = BigInt(card);
  if (k > total) return { ok: false, error: 'cardTooHigh' };
  if (c + k < total) return { ok: false, error: 'notEnough' };
  const payments: Array<{ method: 'cash' | 'card'; amount: string }> = [];
  if (k > 0n) payments.push({ method: 'card', amount: k.toString() });
  if (c > 0n) payments.push({ method: 'cash', amount: c.toString() });
  return { ok: true, payments, change: (c + k - total).toString() };
}

export function saleBody(storeId: string, cart: CartLine[], payments: Array<{ method: string; amount: string }>,
  startedAt: Date, approval?: { email: string; secret: string }):
  { ok: true; body: Record<string, unknown> } | { ok: false; error: PayError; productId?: string } {
  if (!cart.length) return { ok: false, error: 'emptyCart' };
  for (const l of cart) if (!isQuantity(l.quantity)) return { ok: false, error: 'invalidQuantity', productId: l.productId };
  return { ok: true, body: {
    storeId, startedAt: startedAt.toISOString(), payments,
    lines: cart.map((l) => ({ productId: l.productId, quantity: fromMilli(toMilli(l.quantity)), ...(l.discountBp ? { discountBp: l.discountBp } : {}) })),
    ...(approval ? { approval } : {}),
  } };
}

export function cashSuggestions(totalMinor: string): string[] {
  const t = BigInt(totalMinor);
  if (t <= 0n) return [];
  const out = new Set<string>([t.toString()]);
  for (const step of [1000n, 5000n, 10000n, 20000n, 50000n]) out.add((((t + step - 1n) / step) * step).toString());
  return [...out].slice(0, 5);
}
