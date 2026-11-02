import {
  BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { hasPermission } from '../auth/permissions';
import { RequestContext } from '../auth/request-context';
import { DbService } from '../db/db.service';
import {
  BarcodeCreate, LocalizedName, PackagingCreate, ProductCreate, ProductPatch, ProductQuery,
} from './products.dto';

type ProductRow = {
  id: string;
  sku: string;
  name: LocalizedName;
  description: Record<string, string> | null;
  categoryId: string | null;
  unit: string;
  currency: string;
  purchasePrice: string | null;
  salePrice: string | null;
  taxRateBp: number;
  minStock: string;
  shelfLifeDays: number | null;
  trackExpiry: boolean;
  nutrition: unknown;
  allergens: string[];
  imageKey: string | null;
  source: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
};

type BarcodeMatchRow = ProductRow & {
  barcodeCode: string;
  symbology: string | null;
  packQty: string | null;
  packagingId: string | null;
  packagingCode: string | null;
  packagingName: LocalizedName | null;
  factor: string | null;
  gtin: string | null;
};

const PRODUCT_COLUMNS = `
  p.id, p.sku, p.name, p.description,
  p.category_id AS "categoryId", p.unit, p.currency,
  p.purchase_price::text AS "purchasePrice", p.sale_price::text AS "salePrice",
  p.tax_rate_bp AS "taxRateBp", p.min_stock::text AS "minStock",
  p.shelf_life_days AS "shelfLifeDays", p.track_expiry AS "trackExpiry",
  p.nutrition, p.allergens, p.image_key AS "imageKey", p.source, p.is_active AS "isActive",
  p.created_at AS "createdAt", p.updated_at AS "updatedAt"`;

function isPgError(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: string }).code === code;
}

function isUniqueError(error: unknown): boolean {
  return isPgError(error, '23505');
}

function pgConstraint(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'constraint' in error
    ? (error as { constraint?: string }).constraint
    : undefined;
}

function pgMessage(error: unknown): string {
  return typeof error === 'object' && error !== null && 'message' in error
    ? String((error as { message?: unknown }).message ?? '')
    : '';
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

type ProductResponse = Omit<ProductRow, 'purchasePrice'> & { purchasePrice?: string | null };

/** Entfernt sensible Einkaufspreise zentral aus jeder Produktantwort. */
function presentProduct(ctx: RequestContext, product: ProductRow): ProductResponse {
  if (hasPermission(ctx.role, 'report.finance')) return product;
  const { purchasePrice: _purchasePrice, ...visible } = product;
  return visible;
}

type ProductCursor = { createdAt: string; id: string };

function encodeCursor(cursor: ProductCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): ProductCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    const candidate = parsed as { createdAt?: unknown; id?: unknown };
    if (typeof candidate.createdAt !== 'string' || Number.isNaN(Date.parse(candidate.createdAt))) {
      throw new Error('invalid timestamp');
    }
    if (typeof candidate.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(candidate.id)) {
      throw new Error('invalid id');
    }
    return { createdAt: candidate.createdAt, id: candidate.id };
  } catch {
    throw new BadRequestException('Cursor ungültig');
  }
}

@Injectable()
export class ProductsService {
  constructor(private readonly db: DbService) {}

  async list(ctx: RequestContext, query: ProductQuery) {
    const cursor = decodeCursor(query.cursor);
    const search = query.q === undefined ? null : escapeLike(query.q);
    return this.db.withTenant(ctx, async (db) => {
      const result = await db.query<ProductRow>(
        `SELECT ${PRODUCT_COLUMNS}
           FROM app.products p
          WHERE ($1::text IS NULL
             OR p.sku ILIKE '%' || $1 || '%' ESCAPE E'\\\\'
             OR p.name->>'fr' ILIKE '%' || $1 || '%' ESCAPE E'\\\\'
             OR p.name->>'ar' ILIKE '%' || $1 || '%' ESCAPE E'\\\\'
             OR p.name->>'en' ILIKE '%' || $1 || '%' ESCAPE E'\\\\')
            AND ($2::uuid IS NULL OR p.category_id = $2::uuid)
            AND ($3::timestamptz IS NULL
              OR (p.created_at, p.id) > ($3::timestamptz, $4::uuid))
          ORDER BY p.created_at, p.id
          LIMIT $5`,
        [search, query.categoryId ?? null, cursor?.createdAt ?? null, cursor?.id ?? null, query.limit + 1],
      );
      const items = result.rows.slice(0, query.limit);
      const last = items.at(-1);
      return {
        items: items.map((product) => presentProduct(ctx, product)),
        nextCursor: result.rows.length > query.limit && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
      };
    });
  }

  async byBarcode(ctx: RequestContext, code: string) {
    return this.db.withTenant(ctx, async (db) => {
      const direct = await db.query<BarcodeMatchRow>(
        `SELECT ${PRODUCT_COLUMNS}, b.code AS "barcodeCode", b.symbology,
                b.pack_qty::text AS "packQty", NULL::uuid AS "packagingId",
                NULL::text AS "packagingCode", NULL::jsonb AS "packagingName",
                NULL::text AS factor, NULL::text AS gtin
           FROM app.product_barcodes b
           JOIN app.products p ON p.tenant_id = b.tenant_id AND p.id = b.product_id
          WHERE b.code = $1`,
        [code],
      );
      const match = direct.rows[0] ?? (await db.query<BarcodeMatchRow>(
        `SELECT ${PRODUCT_COLUMNS}, pp.gtin AS "barcodeCode", NULL::text AS symbology,
                NULL::text AS "packQty", pp.id AS "packagingId", pp.code AS "packagingCode",
                pp.name AS "packagingName", pp.factor::text AS factor, pp.gtin
           FROM app.product_packagings pp
           JOIN app.products p ON p.tenant_id = pp.tenant_id AND p.id = pp.product_id
          WHERE pp.gtin = $1`,
        [code],
      )).rows[0];

      if (!match) throw new NotFoundException('Barcode nicht gefunden');
      return {
        product: presentProduct(ctx, match),
        barcode: { code: match.barcodeCode, symbology: match.symbology },
        packaging: match.packagingId ? {
          id: match.packagingId,
          code: match.packagingCode,
          name: match.packagingName,
          factor: match.factor,
          gtin: match.gtin,
        } : null,
        quantityPerScan: match.packQty ?? match.factor,
      };
    });
  }

  async create(ctx: RequestContext, body: ProductCreate) {
    if ((body.purchasePrice !== undefined || body.salePrice !== undefined)
        && !hasPermission(ctx.role, 'price.update')) {
      throw new ForbiddenException('Recht fehlt: price.update');
    }
    return this.db.withTenant(ctx, async (db) => {
      try {
        const inserted = await db.query<{ id: string }>(
          `INSERT INTO app.products
             (tenant_id, sku, name, description, category_id, unit, currency,
              purchase_price, sale_price, tax_rate_bp, min_stock, shelf_life_days,
              track_expiry, nutrition, allergens, image_key, source, is_active, created_by)
           VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, COALESCE($6, 'piece'),
                   COALESCE($7, 'TND'), $8::bigint, $9::bigint, COALESCE($10, 1900),
                   COALESCE($11, 0)::numeric, $12, COALESCE($13, true), $14::jsonb,
                   COALESCE($15::text[], '{}'), $16, COALESCE($17, 'manual'), COALESCE($18, true), $19)
           RETURNING id`,
          [ctx.tenantId, body.sku, JSON.stringify(body.name), body.description ? JSON.stringify(body.description) : null,
           body.categoryId ?? null, body.unit ?? null, body.currency ?? null, body.purchasePrice ?? null,
           body.salePrice ?? null, body.taxRateBp ?? null, body.minStock ?? null, body.shelfLifeDays ?? null,
           body.trackExpiry ?? null, body.nutrition === undefined ? null : JSON.stringify(body.nutrition),
           body.allergens ?? null, body.imageKey ?? null, body.source ?? null, body.isActive ?? null, ctx.userId],
        );
        const product = await this.requireProduct(db, inserted.rows[0].id);
        if (body.purchasePrice !== undefined || body.salePrice !== undefined) {
          await db.query(
            `INSERT INTO app.audit_log
               (tenant_id, user_id, action, entity_type, entity_id, before, after)
             VALUES ($1, $2, 'price.update', 'product', $3, NULL, $4::jsonb)`,
            [ctx.tenantId, ctx.userId, product.id,
             JSON.stringify({ purchasePrice: product.purchasePrice, salePrice: product.salePrice })],
          );
        }
        return presentProduct(ctx, product);
      } catch (error: unknown) {
        if (isUniqueError(error)) throw new ConflictException('SKU ist im Mandanten bereits vergeben');
        throw error;
      }
    });
  }

  async update(ctx: RequestContext, productId: string, body: ProductPatch) {
    if ((body.purchasePrice !== undefined || body.salePrice !== undefined)
        && !hasPermission(ctx.role, 'price.update')) {
      throw new ForbiddenException('Recht fehlt: price.update');
    }
    return this.db.withTenant(ctx, async (db) => {
      const before = await this.requireProduct(db, productId);
      const values: Record<string, unknown> = {};
      if (body.sku !== undefined) values.sku = body.sku;
      if (body.name !== undefined) values.name = JSON.stringify(body.name);
      if (body.description !== undefined) values.description = JSON.stringify(body.description);
      if (body.categoryId !== undefined) values.category_id = body.categoryId;
      if (body.unit !== undefined) values.unit = body.unit;
      if (body.currency !== undefined) values.currency = body.currency;
      if (body.purchasePrice !== undefined) values.purchase_price = body.purchasePrice;
      if (body.salePrice !== undefined) values.sale_price = body.salePrice;
      if (body.taxRateBp !== undefined) values.tax_rate_bp = body.taxRateBp;
      if (body.minStock !== undefined) values.min_stock = body.minStock;
      if (body.shelfLifeDays !== undefined) values.shelf_life_days = body.shelfLifeDays;
      if (body.trackExpiry !== undefined) values.track_expiry = body.trackExpiry;
      if (body.nutrition !== undefined) values.nutrition = JSON.stringify(body.nutrition);
      if (body.allergens !== undefined) values.allergens = body.allergens;
      if (body.imageKey !== undefined) values.image_key = body.imageKey;
      if (body.source !== undefined) values.source = body.source;
      if (body.isActive !== undefined) values.is_active = body.isActive;

      const entries = Object.entries(values);
      const assignments = entries.map(([column], index) => `${column} = $${index + 2}`);
      try {
        await db.query(
          `UPDATE app.products SET ${assignments.join(', ')} WHERE id = $1`,
          [productId, ...entries.map(([, value]) => value)],
        );
      } catch (error: unknown) {
        if (isUniqueError(error)) throw new ConflictException('SKU ist im Mandanten bereits vergeben');
        throw error;
      }

      const product = await this.requireProduct(db, productId);
      if (body.purchasePrice !== undefined || body.salePrice !== undefined) {
        await db.query(
          `INSERT INTO app.audit_log
             (tenant_id, user_id, action, entity_type, entity_id, before, after)
           VALUES ($1, $2, 'price.update', 'product', $3, $4::jsonb, $5::jsonb)`,
          [ctx.tenantId, ctx.userId, productId,
           JSON.stringify({ purchasePrice: before.purchasePrice, salePrice: before.salePrice }),
           JSON.stringify({ purchasePrice: product.purchasePrice, salePrice: product.salePrice })],
        );
      }
      return presentProduct(ctx, product);
    });
  }

  async createBarcode(ctx: RequestContext, productId: string, body: BarcodeCreate) {
    return this.db.withTenant(ctx, async (db) => {
      await this.requireProduct(db, productId);
      try {
        await db.query(
          `INSERT INTO app.product_barcodes (tenant_id, product_id, code, symbology, pack_qty)
           VALUES ($1, $2, $3, $4, $5::numeric)`,
          [ctx.tenantId, productId, body.code, body.symbology, body.packQty],
        );
      } catch (error: unknown) {
        if (isUniqueError(error)) throw new ConflictException('Barcode ist im Mandanten bereits vergeben');
        throw error;
      }
      return { productId, code: body.code, symbology: body.symbology, packQty: body.packQty };
    });
  }

  async deleteBarcode(ctx: RequestContext, productId: string, code: string) {
    return this.db.withTenant(ctx, async (db) => {
      const deleted = await db.query<{ code: string }>(
        `DELETE FROM app.product_barcodes WHERE product_id = $1 AND code = $2 RETURNING code`,
        [productId, code],
      );
      if (!deleted.rows[0]) throw new NotFoundException('Barcode nicht gefunden');
      return { productId, code: deleted.rows[0].code };
    });
  }

  async createPackaging(ctx: RequestContext, productId: string, body: PackagingCreate) {
    return this.db.withTenant(ctx, async (db) => {
      await this.requireProduct(db, productId);
      try {
        const result = await db.query<{ id: string }>(
          `INSERT INTO app.product_packagings
             (tenant_id, product_id, code, name, factor, gtin, is_default_sale)
           VALUES ($1, $2, $3, $4::jsonb, $5::numeric, $6, COALESCE($7, false))
           RETURNING id`,
          [ctx.tenantId, productId, body.code, JSON.stringify(body.name), body.factor,
           body.gtin ?? null, body.isDefaultSale ?? null],
        );
        return { id: result.rows[0].id, productId, ...body };
      } catch (error: unknown) {
        if (isUniqueError(error)) {
          const constraint = pgConstraint(error);
          const message = constraint === 'product_packagings_tenant_id_product_id_code_key'
            ? 'Gebinde-Code ist für dieses Produkt bereits vergeben'
            : constraint === 'product_packagings_gtin_unique'
              ? 'GTIN ist im Mandanten bereits vergeben'
              : pgMessage(error).includes('Barcode')
                ? 'Barcode ist im Mandanten bereits vergeben'
                : 'Gebinde oder GTIN ist bereits vergeben';
          throw new ConflictException(message);
        }
        throw error;
      }
    });
  }

  private async requireProduct(db: PoolClient, productId: string): Promise<ProductRow> {
    const result = await db.query<ProductRow>(
      `SELECT ${PRODUCT_COLUMNS} FROM app.products p WHERE p.id = $1`,
      [productId],
    );
    if (!result.rows[0]) throw new NotFoundException('Produkt nicht gefunden');
    return result.rows[0];
  }
}
