import type { AppLanguage } from './language.ts';

export type LocalizedName = Partial<Record<AppLanguage, string>>;

export function productLabel(name: LocalizedName | null | undefined, language: AppLanguage): string {
  if (!name) return '';
  return name[language] ?? name.fr ?? name.ar ?? name.en ?? '';
}

export const SCAN_TYPES = ['ean13', 'ean8', 'upc_a', 'itf14', 'code128', 'qr'] as const;
export type ScanType = (typeof SCAN_TYPES)[number];

export function normalizeScannedCode(data: string): string | null {
  const code = data.trim();
  if (!code || code.length > 100) return null;
  return code;
}

export interface BarcodeLookup {
  product: { id: string; name: LocalizedName; unit: string };
  barcode: { code: string; symbology: string | null };
  packaging: { id: string; code: string; name: LocalizedName; factor: string } | null;
  quantityPerScan: string | null;
}

export interface ScanSummary {
  productId: string;
  label: string;
  /** Menge in Basiseinheiten, die ein Scan bucht (Karton à 12 → "12") */
  perScan: string;
  packagingLabel: string | null;
}

export function describeScan(r: BarcodeLookup, language: AppLanguage): ScanSummary {
  return {
    productId: r.product.id,
    label: productLabel(r.product.name, language),
    perScan: trimDecimal(r.quantityPerScan ?? r.packaging?.factor ?? '1'),
    packagingLabel: r.packaging ? productLabel(r.packaging.name, language) || r.packaging.code : null,
  };
}

export function createFromUnknownBarcode(code: string, type: string | undefined): { barcode: string; symbology: string } {
  const symbology = type && (SCAN_TYPES as readonly string[]).includes(type) ? type : 'ean13';
  return { barcode: code, symbology };
}

export function trimDecimal(value: string): string {
  if (!/^-?\d+(\.\d+)?$/u.test(value)) return value;
  return value.includes('.') ? value.replace(/\.?0+$/u, '') : value;
}

export type StockState = 'negative' | 'low' | 'ok';

export function stockState(quantity: string, minStock: string): StockState {
  const q = Number(quantity);
  if (q < 0) return 'negative';
  return q < Number(minStock) ? 'low' : 'ok';
}

export type ExpiryState = 'expired' | 'soon' | 'ok';

/** Gleiche Schwelle wie das Dashboard: abgelaufen oder in höchstens 7 Tagen. */
export function expiryState(expiryDate: string | null, today: string): ExpiryState | null {
  if (!expiryDate) return null;
  const days = Math.round((Date.parse(`${expiryDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
  if (days < 0) return 'expired';
  return days <= 7 ? 'soon' : 'ok';
}

/** Tausendertrennzeichen sind nicht erlaubt, damit „1.350“ eindeutig 1,350 TND bedeutet. */
export function parseMoneyInput(input: string): string | null {
  const v = input.trim().replace(',', '.');
  const m = /^(\d{1,9})(?:\.(\d{1,3}))?$/u.exec(v);
  if (!m || m[1] === undefined) return null;
  return String(BigInt(m[1]) * 1000n + BigInt((m[2] ?? '').padEnd(3, '0')));
}

export function moneyInputFromMinor(minor: string | null | undefined): string {
  if (!minor || !/^\d+$/u.test(minor)) return '';
  const v = BigInt(minor);
  return `${v / 1000n}.${String(v % 1000n).padStart(3, '0')}`;
}

export function parseQuantityInput(input: string): string | null {
  const v = input.trim().replace(',', '.');
  return /^\d{1,11}(\.\d{1,3})?$/u.test(v) ? v : null;
}

export const UNITS = ['piece', 'kg', 'g', 'l', 'ml', 'pack'] as const;
export const TAX_RATES_BP = [1900, 1300, 700, 0] as const;   // TVA Tunesien

export interface ProductForm {
  sku: string;
  nameFr: string; nameAr: string; nameEn: string;
  unit: (typeof UNITS)[number];
  salePrice: string;
  purchasePrice: string;
  taxRateBp: number;
  minStock: string;
  trackExpiry: boolean;
}

export type ProductFormError = 'skuRequired' | 'skuTaken' | 'nameRequired' | 'invalidPrice' | 'invalidQuantity';

// Preise nur mit price.update – sonst lehnt der Server mit 403 ab.
export function productBodyFromForm(form: ProductForm, opts: { canEditPrices: boolean; source?: 'manual' | 'barcode' }):
  { ok: true; body: Record<string, unknown> } | { ok: false; errors: Partial<Record<keyof ProductForm, ProductFormError>> } {
  const errors: Partial<Record<keyof ProductForm, ProductFormError>> = {};
  const name: LocalizedName = {};
  if (form.nameFr.trim()) name.fr = form.nameFr.trim();
  if (form.nameAr.trim()) name.ar = form.nameAr.trim();
  if (form.nameEn.trim()) name.en = form.nameEn.trim();
  if (!form.sku.trim()) errors.sku = 'skuRequired';
  if (Object.keys(name).length === 0) errors.nameFr = 'nameRequired';

  const body: Record<string, unknown> = {
    sku: form.sku.trim(), name, unit: form.unit, taxRateBp: form.taxRateBp, trackExpiry: form.trackExpiry,
  };
  if (opts.source) body.source = opts.source;
  if (form.minStock.trim()) {
    const q = parseQuantityInput(form.minStock);
    if (q === null) errors.minStock = 'invalidQuantity'; else body.minStock = q;
  }
  if (opts.canEditPrices) {
    for (const field of ['salePrice', 'purchasePrice'] as const) {
      if (!form[field].trim()) continue;
      const minor = parseMoneyInput(form[field]);
      if (minor === null) errors[field] = 'invalidPrice'; else body[field] = minor;
    }
  }
  return Object.keys(errors).length ? { ok: false, errors } : { ok: true, body };
}

// PATCH verlangt mindestens ein Feld.
export function changedFields(before: Record<string, unknown>, after: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(after)) {
    if (JSON.stringify(before[k] ?? null) !== JSON.stringify(v ?? null)) out[k] = v;
  }
  return out;
}

export interface ProductDetail {
  product: {
    id: string; sku: string; name: LocalizedName; unit: string; salePrice: string | null; purchasePrice?: string | null;
    taxRateBp: number; minStock: string; trackExpiry: boolean; isActive: boolean;
  };
  barcodes: Array<{ code: string; symbology: string; packQty: string }>;
  packagings: Array<{ id: string; code: string; name: LocalizedName; factor: string; gtin: string | null }>;
  stock: null | {
    quantity: string; minStock: string; shelfLocation: string | null;
    lots: Array<{ id: string; lotNumber: string | null; expiryDate: string | null; quantity: string }>;
  };
}
