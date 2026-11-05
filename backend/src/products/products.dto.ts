import { z } from 'zod';

const languageText = z.string().trim().min(1).max(500);

/** Produktnamen werden als i18n-Objekt gespeichert; mindestens eine Sprache ist Pflicht. */
export const LocalizedName = z.object({
  ar: languageText.optional(),
  fr: languageText.optional(),
  en: languageText.optional(),
}).strict().refine((name) => Object.values(name).some((value) => value !== undefined), {
  message: 'Mindestens eine Sprache (ar, fr oder en) ist erforderlich',
});
export type LocalizedName = z.infer<typeof LocalizedName>;

const money = z.string().regex(/^\d+$/, 'Betrag muss in Minor Units angegeben werden');
const decimal = z.string().regex(/^\d{1,11}(\.\d{1,3})?$/, 'Ungültige Dezimalzahl');
const positiveDecimal = decimal.refine((value) => /[1-9]/.test(value), 'Wert muss größer als 0 sein');

export const ProductCreate = z.object({
  sku: z.string().trim().min(1).max(100),
  name: LocalizedName,
  description: z.record(z.string(), languageText).optional(),
  categoryId: z.string().uuid().optional(),
  unit: z.enum(['piece', 'kg', 'g', 'l', 'ml', 'pack']).optional(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  purchasePrice: money.optional(),
  salePrice: money.optional(),
  taxRateBp: z.coerce.number().int().min(0).max(10000).optional(),
  minStock: decimal.optional(),
  shelfLifeDays: z.number().int().min(0).max(36500).optional(),
  trackExpiry: z.boolean().optional(),
  nutrition: z.unknown().optional(),
  allergens: z.array(z.string().trim().min(1).max(100)).max(100).optional(),
  imageKey: z.string().trim().max(500).optional(),
  source: z.enum(['manual', 'barcode', 'ai', 'import', 'document']).optional(),
  isActive: z.boolean().optional(),
}).strict();
export type ProductCreate = z.infer<typeof ProductCreate>;

export const ProductPatch = ProductCreate.partial().refine((body) => Object.keys(body).length > 0, {
  message: 'Mindestens ein Feld ist erforderlich',
});
export type ProductPatch = z.infer<typeof ProductPatch>;

export const ProductQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  categoryId: z.string().uuid().optional(),
  cursor: z.string().trim().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
export type ProductQuery = z.infer<typeof ProductQuery>;

export const BarcodeCreate = z.object({
  code: z.string().trim().min(1).max(100),
  symbology: z.string().trim().min(1).max(50).default('ean13'),
  packQty: positiveDecimal.default('1.000'),
}).strict();
export type BarcodeCreate = z.infer<typeof BarcodeCreate>;

export const PackagingCreate = z.object({
  code: z.string().trim().min(1).max(50),
  name: LocalizedName,
  factor: positiveDecimal,
  gtin: z.string().trim().min(1).max(100).optional(),
  isDefaultSale: z.boolean().optional(),
}).strict();
export type PackagingCreate = z.infer<typeof PackagingCreate>;

export const ProductDetailQuery = z.object({ storeId: z.string().uuid().optional() }).strict();
export type ProductDetailQuery = z.infer<typeof ProductDetailQuery>;

const importMoney = z.string().regex(/^\d{1,15}$/u, 'Betrag in Millimes');
const importQty = z.string().regex(/^\d{1,11}(\.\d{1,3})?$/u, 'Menge');

/** Zeile aus der Import-Datei, in der App bereits normalisiert (Beträge in Millimes). */
export const ImportRow = z.object({
  line: z.number().int().min(1),
  sku: z.string().trim().min(1).max(100),
  name: LocalizedName,
  unit: z.enum(['piece', 'kg', 'g', 'l', 'ml', 'pack']).optional(),
  salePrice: importMoney.optional(),
  purchasePrice: importMoney.optional(),
  taxRateBp: z.number().int().min(0).max(10000).optional(),
  minStock: importQty.optional(),
  trackExpiry: z.boolean().optional(),
  barcode: z.string().trim().min(1).max(100).optional(),
  carton: z.object({
    factor: importQty.refine((v) => /[1-9]/u.test(v), 'Faktor > 0'),
    gtin: z.string().trim().min(1).max(100).optional(),
  }).strict().optional(),
}).strict();
export type ImportRow = z.infer<typeof ImportRow>;

export const ProductImport = z.object({
  mode: z.enum(['check', 'apply']),
  rows: z.array(ImportRow).min(1).max(5000),
}).strict();
export type ProductImport = z.infer<typeof ProductImport>;
