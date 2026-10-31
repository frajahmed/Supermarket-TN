import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../db/db.service';
import { RequestContext } from '../auth/request-context';
import { hasPermission, MOVEMENT_PERMISSION } from '../auth/permissions';
import { MovementInput, PullQuery, PushRequest, PushResultItem } from './inventory.dto';

/** Postgres-Fehlercodes, die eine einzelne Bewegung ablehnen statt den Stapel abzubrechen. */
const REJECTABLE = new Map<string, string>([
  ['23514', 'Regel verletzt (Vorzeichen passt nicht zum Typ oder Begründung fehlt)'],
  ['23503', 'Produkt, Filiale oder Charge unbekannt'],
  ['42501', 'Keine Berechtigung für diese Filiale oder Buchungsart'],
]);

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
}
