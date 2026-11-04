import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuthFlowProvider } from '../auth/auth.module-providers';
import { RequestContext } from '../auth/request-context';
import { AuthError } from '../core/auth-flow.ts';
import { renderReceipt } from '../core/receipt-document.ts';
import { DbService } from '../db/db.service';
import { assertStoreAccess } from '../inventory/inventory.controller';
import { SaleCreate, SaleQuery, SaleVoid } from './pos.dto';

/** Dünne Schicht über app.complete_sale / app.void_sale (db/010_pos.sql). */
@Injectable()
export class PosService {
  constructor(private readonly db: DbService, private readonly auth: AuthFlowProvider) {}

  async config(ctx: RequestContext) {
    return this.db.withTenant(ctx, async (db) => {
      const r = await db.query<{ bp: number }>(
        `SELECT coalesce((settings->>'cashier_max_discount_bp')::int, 500) AS bp FROM app.tenants WHERE id = $1`, [ctx.tenantId]);
      return { cashierMaxDiscountBp: r.rows[0]?.bp ?? 500, canApproveDiscount: ctx.role === 'owner' || ctx.role === 'manager' };
    });
  }

  async complete(ctx: RequestContext, b: SaleCreate) {
    if (!ctx.deviceId) throw new ForbiddenException('Verkauf nur an einem freigeschalteten Gerät');
    assertStoreAccess(ctx, b.storeId);
    let approver: string | null = null;
    if (b.approval) {
      try {
        approver = await this.auth.flow.verifyApprover({ tenantId: ctx.tenantId, email: b.approval.email,
          secret: b.approval.secret, deviceId: ctx.deviceId, roles: ['owner', 'manager'] });
      } catch (e) {
        if (e instanceof AuthError) {
          throw new HttpException({ message: e.message, code: 'APPROVAL_FAILED' }, e.status === 401 ? 403 : e.status);
        }
        throw e;
      }
    }
    return this.run(ctx, async (db) => {
      const r = await db.query<{ id: string }>(
        'SELECT app.complete_sale($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7::timestamptz) AS id',
        [b.storeId, ctx.deviceId, JSON.stringify(b.lines), JSON.stringify(b.payments), approver, b.clientOpId, b.startedAt ?? null]);
      const sale = await this.load(db, r.rows[0].id);
      const tendered = b.payments.reduce((s, p) => s + BigInt(p.amount), 0n);
      return { ...sale, change: (tendered - BigInt(sale.grossTotal)).toString() };
    });
  }

  async void(ctx: RequestContext, saleId: string, b: SaleVoid) {
    if (!ctx.deviceId) throw new ForbiddenException('Storno nur an einem freigeschalteten Gerät');
    return this.run(ctx, async (db) => {
      const r = await db.query<{ id: string }>('SELECT app.void_sale($1, $2, $3, $4) AS id', [saleId, ctx.deviceId, b.reason, b.clientOpId]);
      return this.load(db, r.rows[0].id);
    });
  }

  async list(ctx: RequestContext, q: SaleQuery) {
    assertStoreAccess(ctx, q.storeId);
    return this.run(ctx, async (db) => {
      const r = await db.query(
        `SELECT s.id, s.receipt_number AS "receiptNumber", s.device_id AS "deviceId", coalesce(d.name, 'Caisse') AS "deviceName",
                s.gross_total::text AS "grossTotal", s.completed_at AS "completedAt", s.voids_sale_id AS "voidsSaleId",
                EXISTS (SELECT 1 FROM app.sales v WHERE v.voids_sale_id = s.id) AS voided, coalesce(u.display_name, '') AS cashier
           FROM app.sales s LEFT JOIN app.devices d ON d.id = s.device_id LEFT JOIN app.users u ON u.id = s.cashier_id
          WHERE s.store_id = $1 AND s.status = 'completed'
            AND s.completed_at >= coalesce($2::date, current_date) AND s.completed_at < coalesce($2::date, current_date) + 1
            AND (NOT $3::boolean OR s.cashier_id = $4)
          ORDER BY s.completed_at DESC LIMIT 200`,
        [q.storeId, q.date ?? null, q.mine === 'true' || ctx.role === 'cashier', ctx.userId]);
      const totals = r.rows.reduce((t, s: { grossTotal: string }) => t + BigInt(s.grossTotal), 0n);
      return { items: r.rows, total: totals.toString() };
    });
  }

  async get(ctx: RequestContext, id: string) {
    return this.run(ctx, (db) => this.load(db, id));
  }

  async receipt(ctx: RequestContext, id: string): Promise<string> {
    return this.run(ctx, async (db) => {
      const s = await this.load(db, id);
      const t = (await db.query<{ name: string; taxId: string | null; store: string }>(
        `SELECT coalesce(t.legal_name, t.name) AS name, t.tax_id AS "taxId", st.name AS store
           FROM app.tenants t JOIN app.stores st ON st.id = $2 WHERE t.id = $1`, [ctx.tenantId, s.storeId])).rows[0];
      return renderReceipt({
        seller: { name: t?.name ?? '', taxId: t?.taxId ?? null, store: t?.store ?? '' },
        receiptNumber: s.receiptNumber, deviceName: s.deviceName, cashier: s.cashier, completedAt: s.completedAt,
        voidsReceiptNumber: s.voidsReceiptNumber, voidReason: s.voidReason,
        lines: s.lines, payments: s.payments,
        totals: { gross: s.grossTotal, tax: s.taxTotal, net: s.netTotal, discount: s.discountTotal },
      });
    });
  }

  private async load(db: PoolClient, id: string) {
    const r = await db.query(
      `SELECT s.id, s.store_id AS "storeId", s.receipt_number::text AS "receiptNumber", s.status, coalesce(d.name, 'Caisse') AS "deviceName",
              coalesce(u.display_name, '') AS cashier, s.completed_at AS "completedAt", s.gross_total::text AS "grossTotal",
              s.tax_total::text AS "taxTotal", s.net_total::text AS "netTotal", s.discount_total::text AS "discountTotal",
              s.voids_sale_id AS "voidsSaleId", o.receipt_number::text AS "voidsReceiptNumber", s.void_reason AS "voidReason",
              s.discount_approved_by AS "discountApprovedBy",
              EXISTS (SELECT 1 FROM app.sales v WHERE v.voids_sale_id = s.id) AS voided
         FROM app.sales s LEFT JOIN app.devices d ON d.id = s.device_id LEFT JOIN app.users u ON u.id = s.cashier_id
         LEFT JOIN app.sales o ON o.id = s.voids_sale_id
        WHERE s.id = $1`, [id]);
    if (!r.rows[0]) throw new NotFoundException('Bon nicht gefunden');
    const [lines, payments] = await Promise.all([
      db.query(`SELECT line_no AS "lineNo", product_id AS "productId", product_name AS "productName", quantity::text AS quantity,
                       unit_price::text AS "unitPrice", discount::text AS discount, tax_rate_bp AS "taxRateBp", line_total::text AS "lineTotal"
                  FROM app.sale_lines WHERE sale_id = $1 ORDER BY line_no`, [id]),
      db.query(`SELECT method, amount::text AS amount, terminal_ref AS "terminalRef" FROM app.payments WHERE sale_id = $1 ORDER BY created_at`, [id]),
    ]);
    return { ...r.rows[0], lines: lines.rows, payments: payments.rows };
  }

  private async run<T>(ctx: RequestContext, fn: (db: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.db.withTenant(ctx, fn);
    } catch (e: unknown) {
      if (e instanceof HttpException) throw e;
      const err = e as { code?: string; message?: string };
      switch (err.code) {
        case 'SN403': throw new ForbiddenException({ message: err.message, code: 'DISCOUNT_APPROVAL' });
        case 'SN409': throw new ConflictException(err.message);
        case 'SN422': throw new UnprocessableEntityException(err.message);
        case 'P0002': throw new NotFoundException(err.message);
        case '42501': throw new ForbiddenException(err.message ?? 'Keine Berechtigung');
        case '22P02': throw new BadRequestException('Ungültige Eingabe');
        case '23503': throw new UnprocessableEntityException('Gerät, Filiale oder Produkt unbekannt');
        default: throw e;
      }
    }
  }
}

