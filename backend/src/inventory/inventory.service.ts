import { BadRequestException, Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../db/db.service';
import { RequestContext } from '../auth/request-context';
import { hasPermission, MOVEMENT_PERMISSION } from '../auth/permissions';
import { MovementInput, PullQuery, PushRequest, PushResultItem, StockQuery } from './inventory.dto';

/** Postgres-Fehlercodes, die eine einzelne Bewegung ablehnen statt den Stapel abzubrechen. */
const REJECTABLE = new Map<string, string>([
  ['23514', 'Regel verletzt (Vorzeichen passt nicht zum Typ oder Begründung fehlt)'],
  ['23503', 'Produkt, Filiale oder Charge unbekannt'],
  ['42501', 'Keine Berechtigung für diese Filiale oder Buchungsart'],
]);


type StockRow = {
  productId: string; sku: string; name: Record<string, string>; unit: string; salePrice: string | null;
  purchasePrice: string | null; quantity: string; minStock: string; belowMin: boolean;
  nextExpiry: string | null; shelfLocation: string | null;
};

function encodeStockCursor(c: { sku: string; id: string }): string {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeStockCursor(value: string | undefined): { sku: string; id: string } | undefined {
  if (!value) return undefined;
  try {
    const c = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { sku?: unknown; id?: unknown };
    if (typeof c.sku !== 'string' || typeof c.id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(c.id)) throw new Error('cursor');
    return { sku: c.sku, id: c.id };
  } catch {
    throw new BadRequestException('Cursor ungültig');
  }
}

@Injectable()
export class InventoryService {
  constructor(private readonly db: DbService) {}

  /**
   * Bucht einen Stapel Bewegungen aus der Offline-Queue eines Geräts.
   *
   * - Idempotent: eine bereits bekannte clientOpId wird als 'duplicate' gemeldet,
   *   nicht erneut gebucht. Das Gerät darf nach Verbindungsabbruch einfach erneut senden.
   * - Jede Bewegung läuft in einem SAVEPOINT: eine ungültige Zeile lehnt nur sich selbst ab.
   * - Bestand, Charge und Echtzeit-Event schreibt der DB-Trigger in derselben Transaktion.
   */
  async push(ctx: RequestContext, req: PushRequest): Promise<PushResultItem[]> {
    return this.db.withTenant(ctx, async (db) => {
      const results: PushResultItem[] = [];
      for (const m of req.movements) {
        results.push(await this.pushOne(db, ctx, m));
      }
      return results;
    });
  }

  private async pushOne(db: PoolClient, ctx: RequestContext, m: MovementInput): Promise<PushResultItem> {
    // Erste Linie: Rechteprüfung im Code (zweite Linie: RLS-Policy movements_insert)
    if (!hasPermission(ctx.role, MOVEMENT_PERMISSION[m.type])) {
      return { clientOpId: m.clientOpId, status: 'rejected', error: `Buchungsart ${m.type} nicht erlaubt` };
    }
    await db.query('SAVEPOINT mv');
    try {
      const res = await db.query<{ id: string }>(
        `INSERT INTO app.stock_movements
           (tenant_id, store_id, product_id, lot_id, type, quantity_delta, unit_cost, reason,
            ref_type, ref_id, client_op_id, device_id, user_id, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6::numeric, $7::bigint, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (tenant_id, client_op_id) DO NOTHING
         RETURNING id`,
        [ctx.tenantId, m.storeId, m.productId, m.lotId ?? null, m.type, m.quantityDelta,
         m.unitCost ?? null, m.reason ?? null, m.refType ?? null, m.refId ?? null,
         m.clientOpId, ctx.deviceId ?? null, ctx.userId, m.occurredAt],
      );
      await db.query('RELEASE SAVEPOINT mv');
      return res.rows[0]
        ? { clientOpId: m.clientOpId, status: 'accepted', movementId: String(res.rows[0].id) }
        : { clientOpId: m.clientOpId, status: 'duplicate' };
    } catch (err: unknown) {
      await db.query('ROLLBACK TO SAVEPOINT mv');
      const code = (err as { code?: string }).code ?? '';
      const message = REJECTABLE.get(code);
      if (message) return { clientOpId: m.clientOpId, status: 'rejected', error: message };
      throw err; // unerwarteter Fehler -> ganzer Stapel zurück, Gerät versucht es später erneut
    }
  }

  /**
   * GET /sync/pull – alles seit dem letzten Cursor einer Filiale.
   * Der Journal-Id dient als monotoner Cursor; das Gerät speichert `nextCursor`.
   */
  async pull(ctx: RequestContext, q: PullQuery) {
    return this.db.withTenant(ctx, async (db) => {
      const moves = await db.query(
        `SELECT id::text, product_id AS "productId", lot_id AS "lotId", type,
                quantity_delta::text AS "quantityDelta", occurred_at AS "occurredAt",
                client_op_id AS "clientOpId"
           FROM app.stock_movements
          WHERE store_id = $1 AND id > $2
          ORDER BY id
          LIMIT $3`,
        [q.storeId, q.since, q.limit],
      );
      const productIds = [...new Set(moves.rows.map((r) => r.productId as string))];
      const stock = productIds.length
        ? (await db.query(
            `SELECT product_id AS "productId", quantity::text AS quantity
               FROM app.store_stock WHERE store_id = $1 AND product_id = ANY($2::uuid[])`,
            [q.storeId, productIds],
          )).rows
        : [];
      const last = moves.rows.at(-1);
      return {
        movements: moves.rows,
        stock,                                    // autoritative Bestände der betroffenen Produkte
        nextCursor: last ? Number(last.id) : q.since,
        hasMore: moves.rows.length === q.limit,
      };
    });
  }

  /** Dashboard: Bestand einer Filiale inkl. Warnungen für Mindestbestand und MHD (7 Tage). */
  async storeOverview(ctx: RequestContext, storeId: string) {
    return this.db.withTenant(ctx, async (db) => {
      const [low, expiring] = await Promise.all([
        db.query(
          `SELECT product_id AS "productId", sku, name, quantity::text, min_stock::text AS "minStock"
             FROM app.v_low_stock WHERE store_id = $1 ORDER BY quantity - min_stock`,
          [storeId],
        ),
        db.query(
          `SELECT product_id AS "productId", sku, name, lot_number AS "lotNumber",
                  expiry_date AS "expiryDate", days_left AS "daysLeft", quantity::text
             FROM app.v_expiring_lots WHERE store_id = $1 ORDER BY expiry_date`,
          [storeId],
        ),
      ]);
      return { lowStock: low.rows, expiringSoon: expiring.rows };
    });
  }

  /**
   * Bestandsliste einer Filiale (T-110): Produkt, Bestand, Mindestbestand, nächstes MHD.
   * Suche über SKU, Namen (ar/fr/en) und exakten Barcode. Einkaufspreis nur mit report.finance.
   */
  async stockList(ctx: RequestContext, storeId: string, q: StockQuery) {
    const cursor = decodeStockCursor(q.cursor);
    const search = q.q ?? null;
    const like = search === null ? null : search.replace(/[\\%_]/g, '\\$&');
    return this.db.withTenant(ctx, async (db) => {
      const r = await db.query<StockRow>(
        `SELECT p.id AS "productId", p.sku, p.name, p.unit,
                COALESCE(sp.sale_price, p.sale_price)::text AS "salePrice",
                p.purchase_price::text AS "purchasePrice",
                COALESCE(ss.quantity, 0)::text AS quantity,
                COALESCE(sp.min_stock, p.min_stock)::text AS "minStock",
                COALESCE(ss.quantity, 0) < COALESCE(sp.min_stock, p.min_stock) AS "belowMin",
                (SELECT min(l.expiry_date) FROM app.stock_lots l
                  WHERE l.store_id = $1 AND l.product_id = p.id AND l.quantity > 0)::text AS "nextExpiry",
                sp.shelf_location AS "shelfLocation"
           FROM app.products p
           LEFT JOIN app.store_stock ss ON ss.store_id = $1 AND ss.product_id = p.id
           LEFT JOIN app.store_products sp ON sp.store_id = $1 AND sp.product_id = p.id
          WHERE p.is_active
            AND ($2::text IS NULL
              OR p.sku ILIKE '%' || $3 || '%' ESCAPE E'\\\\'
              OR p.name->>'fr' ILIKE '%' || $3 || '%' ESCAPE E'\\\\'
              OR p.name->>'ar' ILIKE '%' || $3 || '%' ESCAPE E'\\\\'
              OR p.name->>'en' ILIKE '%' || $3 || '%' ESCAPE E'\\\\'
              OR EXISTS (SELECT 1 FROM app.product_barcodes b WHERE b.product_id = p.id AND b.code = $2)
              OR EXISTS (SELECT 1 FROM app.product_packagings pp WHERE pp.product_id = p.id AND pp.gtin = $2))
            AND ($4::text IS NULL OR (p.sku, p.id) > ($4::text, $5::uuid))
            AND (NOT $6::boolean OR COALESCE(ss.quantity, 0) < COALESCE(sp.min_stock, p.min_stock))
          ORDER BY p.sku, p.id
          LIMIT $7`,
        [storeId, search, like, cursor?.sku ?? null, cursor?.id ?? null, q.low === 'true', q.limit + 1],
      );
      const items = r.rows.slice(0, q.limit);
      const last = items.at(-1);
      const showCost = hasPermission(ctx.role, 'report.finance');
      return {
        items: items.map(({ purchasePrice, ...rest }) => (showCost ? { ...rest, purchasePrice } : rest)),
        nextCursor: r.rows.length > q.limit && last ? encodeStockCursor({ sku: last.sku, id: last.productId }) : null,
      };
    });
  }
}
