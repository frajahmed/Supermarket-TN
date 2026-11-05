import { parseMoneyInput, parseQuantityInput, UNITS } from './products.ts';

/** Excel speichert CSV je nach Sprache mit „;“ (fr) oder „,“ (en); Tab für Kopieren aus Tabellen. */
export function detectDelimiter(headerLine: string): ',' | ';' | '\t' {
  const counts = { ';': 0, ',': 0, '\t': 0 } as Record<',' | ';' | '\t', number>;
  for (const ch of headerLine) if (ch in counts) counts[ch as ',' | ';' | '\t']++;
  return (Object.entries(counts).sort((a, b) => b[1] - a[1])[0]![0]) as ',' | ';' | '\t';
}

/** CSV nach RFC 4180 (Anführungszeichen, "" als Escape, Zeilenumbrüche in Feldern). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/u, '');
  const firstLine = src.split(/\r?\n/u, 1)[0] ?? '';
  const delimiter = detectDelimiter(firstLine);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === delimiter) { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

export type ImportField = 'sku' | 'nameFr' | 'nameAr' | 'nameEn' | 'unit' | 'salePrice' | 'purchasePrice' | 'taxRate'
  | 'minStock' | 'trackExpiry' | 'barcode' | 'cartonFactor' | 'cartonBarcode';

const ALIASES: Record<ImportField, string[]> = {
  sku: ['sku', 'ref', 'reference', 'code_article', 'article', 'artikelnummer'],
  nameFr: ['name_fr', 'nom', 'nom_fr', 'designation', 'libelle', 'name'],
  nameAr: ['name_ar', 'nom_ar', 'الاسم', 'اسم'],
  nameEn: ['name_en', 'nom_en'],
  unit: ['unit', 'unite', 'einheit'],
  salePrice: ['sale_price', 'prix', 'prix_vente', 'prix_ttc', 'pv', 'verkaufspreis'],
  purchasePrice: ['purchase_price', 'prix_achat', 'pa', 'einkaufspreis'],
  taxRate: ['tax_rate', 'tva', 'vat', 'taux_tva'],
  minStock: ['min_stock', 'stock_min', 'stock_minimum', 'mindestbestand'],
  trackExpiry: ['track_expiry', 'dlc', 'mhd', 'peremption'],
  barcode: ['barcode', 'code_barre', 'code_barres', 'ean', 'gtin'],
  cartonFactor: ['carton', 'carton_factor', 'colisage', 'pcs_carton', 'karton'],
  cartonBarcode: ['carton_barcode', 'ean_carton', 'gtin_carton', 'code_barre_carton'],
};

export function normalizeHeader(h: string): string {
  return h.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/gu, '').replace(/[\s.\-/]+/gu, '_').replace(/[()%]/gu, '').replace(/_+$/u, '');
}

export function mapHeaders(headers: string[]): { columns: Partial<Record<ImportField, number>>; unknown: string[] } {
  const columns: Partial<Record<ImportField, number>> = {};
  const unknown: string[] = [];
  headers.forEach((h, i) => {
    const n = normalizeHeader(h);
    const field = (Object.keys(ALIASES) as ImportField[]).find((f) => ALIASES[f].includes(n));
    if (field && columns[field] === undefined) columns[field] = i;
    else if (n) unknown.push(h.trim());
  });
  return { columns, unknown };
}

const UNIT_WORDS: Record<string, (typeof UNITS)[number]> = {
  piece: 'piece', pieces: 'piece', pcs: 'piece', pc: 'piece', u: 'piece', unite: 'piece', stk: 'piece', stuck: 'piece',
  kg: 'kg', kilo: 'kg', g: 'g', gr: 'g', gramme: 'g', l: 'l', litre: 'l', liter: 'l', ml: 'ml', pack: 'pack', paquet: 'pack', packung: 'pack',
};

export type ImportErrorCode = 'skuMissing' | 'nameMissing' | 'invalidUnit' | 'invalidPrice' | 'invalidTax' | 'invalidQuantity'
  | 'invalidYesNo' | 'duplicateSku' | 'cartonBarcodeWithoutFactor';

export interface ImportRow {
  line: number; sku: string; name: { fr?: string; ar?: string; en?: string };
  unit?: (typeof UNITS)[number]; salePrice?: string; purchasePrice?: string; taxRateBp?: number; minStock?: string;
  trackExpiry?: boolean; barcode?: string; carton?: { factor: string; gtin?: string };
}

export interface ImportParseResult {
  rows: ImportRow[];
  errors: Array<{ line: number; field: ImportField | 'file'; code: ImportErrorCode | 'noSkuColumn' | 'noNameColumn' | 'empty' }>;
  unknownColumns: string[];
  withPrices: boolean;
}

function parseYesNo(v: string): boolean | null {
  const n = normalizeHeader(v);
  if (['oui', 'o', 'yes', 'y', 'ja', '1', 'x', 'نعم'].includes(n)) return true;
  if (['non', 'n', 'no', 'nein', '0', 'لا'].includes(n)) return false;
  return null;
}

/** TVA als „19“, „19 %“ oder „0,19“; nur die tunesischen Sätze 19/13/7/0. */
function parseTax(v: string): number | null {
  const n = Number(v.replace('%', '').replace(',', '.').trim());
  if (Number.isNaN(n)) return null;
  const bp = Math.round((n < 1 && n > 0 ? n * 100 : n) * 100);
  return [1900, 1300, 700, 0].includes(bp) ? bp : null;
}

/** Datei → Zeilen für POST /products/import; Zeilennummern wie in Excel (Kopfzeile = 1). */
export function rowsFromCsv(text: string): ImportParseResult {
  const table = parseCsv(text);
  const result: ImportParseResult = { rows: [], errors: [], unknownColumns: [], withPrices: false };
  if (table.length < 2) { result.errors.push({ line: 1, field: 'file', code: 'empty' }); return result; }
  const { columns, unknown } = mapHeaders(table[0]!);
  result.unknownColumns = unknown;
  if (columns.sku === undefined) result.errors.push({ line: 1, field: 'file', code: 'noSkuColumn' });
  if (columns.nameFr === undefined && columns.nameAr === undefined && columns.nameEn === undefined) {
    result.errors.push({ line: 1, field: 'file', code: 'noNameColumn' });
  }
  if (result.errors.length) return result;

  const skus = new Map<string, number>();
  table.slice(1).forEach((cells, i) => {
    const line = i + 2;
    const get = (f: ImportField) => (columns[f] === undefined ? '' : (cells[columns[f]!] ?? '').trim());
    const fail = (field: ImportField, code: ImportErrorCode) => { result.errors.push({ line, field, code }); };
    const before = result.errors.length;

    const sku = get('sku');
    if (!sku) fail('sku', 'skuMissing');
    else if (skus.has(sku.toLowerCase())) fail('sku', 'duplicateSku');
    else skus.set(sku.toLowerCase(), line);
    const name: ImportRow['name'] = {};
    if (get('nameFr')) name.fr = get('nameFr');
    if (get('nameAr')) name.ar = get('nameAr');
    if (get('nameEn')) name.en = get('nameEn');
    if (!Object.keys(name).length) fail('nameFr', 'nameMissing');

    const row: ImportRow = { line, sku, name };
    if (get('unit')) {
      const u = UNIT_WORDS[normalizeHeader(get('unit'))];
      if (u) row.unit = u; else fail('unit', 'invalidUnit');
    }
    for (const f of ['salePrice', 'purchasePrice'] as const) {
      if (!get(f)) continue;
      const minor = parseMoneyInput(get(f).replace(/\s|TND|DT|د\.ت/giu, ''));
      if (minor === null) fail(f, 'invalidPrice'); else { row[f] = minor; result.withPrices = true; }
    }
    if (get('taxRate')) {
      const bp = parseTax(get('taxRate'));
      if (bp === null) fail('taxRate', 'invalidTax'); else row.taxRateBp = bp;
    }
    if (get('minStock')) {
      const q = parseQuantityInput(get('minStock'));
      if (q === null) fail('minStock', 'invalidQuantity'); else row.minStock = q;
    }
    if (get('trackExpiry')) {
      const yn = parseYesNo(get('trackExpiry'));
      if (yn === null) fail('trackExpiry', 'invalidYesNo'); else row.trackExpiry = yn;
    }
    if (get('barcode')) row.barcode = get('barcode');
    if (get('cartonFactor')) {
      const q = parseQuantityInput(get('cartonFactor'));
      if (q === null || !/[1-9]/u.test(q)) fail('cartonFactor', 'invalidQuantity');
      else row.carton = { factor: q, ...(get('cartonBarcode') ? { gtin: get('cartonBarcode') } : {}) };
    } else if (get('cartonBarcode')) fail('cartonBarcode', 'cartonBarcodeWithoutFactor');

    if (result.errors.length === before) result.rows.push(row);
  });
  return result;
}

export const IMPORT_TEMPLATE_HEADERS = ['reference', 'nom_fr', 'nom_ar', 'unite', 'prix_ttc', 'prix_achat', 'tva', 'stock_min',
  'dlc', 'code_barre', 'carton', 'ean_carton'];

/** Vorlage mit „;“ – öffnet sich in französischem Excel direkt in Spalten. */
export function importTemplateCsv(): string {
  return `﻿${IMPORT_TEMPLATE_HEADERS.join(';')}\r\nLAIT-1L;Lait Délice 1 L;حليب ديليس 1 لتر;piece;1,350;1,100;7;24;oui;6194001234567;12;06194001234574\r\n`;
}
