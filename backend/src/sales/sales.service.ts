import {
  ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException, UnprocessableEntityException,
} from '@nestjs/common';
import { PoolClient } from 'pg';
import { RequestContext } from '../auth/request-context';
import { renderSalesDocument, type DocumentParty } from '../core/sales-document.ts';
import { DbService } from '../db/db.service';
import { CreditNoteCreate, DeliveryCreate, SalesOrderConfirm, SalesOrderCreate } from './sales.dto';

/**
 * Dünne Schicht über den SQL-Funktionen aus db/008_sales_flow.sql.
 * Die Geschäftsregeln (Kreditlimit, Mengen, Nummernkreise, Lagerbuchung) liegen in der
 * Datenbank und laufen unter RLS als aufrufende Rolle.
 */
@Injectable()
export class SalesService {
  constructor(private readonly db: DbService) {}

  createOrder(ctx: RequestContext, b: SalesOrderCreate) {
    return this.run(ctx, async (db) => {
      const r = await db.query<{ id: string }>(
        'SELECT app.create_sales_order($1, $2, $3::jsonb, $4::date, $5, $6) AS id',
        [b.storeId, b.customerId, JSON.stringify(b.lines), b.requestedDate ?? null, b.note ?? null, b.clientOpId ?? null],
      );
      return this.loadOrder(db, r.rows[0].id);
    });
  }

  getOrder(ctx: RequestContext, id: string) {
    return this.run(ctx, (db) => this.loadOrder(db, id));
  }

  confirmOrder(ctx: RequestContext, id: string, b: SalesOrderConfirm) {
    if (b.overrideReason !== undefined && ctx.role !== 'owner') {
      throw new ForbiddenException('Nur der Inhaber kann das Kreditlimit übersteuern');
    }
    return this.run(ctx, async (db) => {
      await db.query('SELECT app.confirm_sales_order($1, $2)', [id, b.overrideReason ?? null]);
      return this.loadOrder(db, id);
    });
  }

  deliver(ctx: RequestContext, orderId: string, b: DeliveryCreate) {
    return this.run(ctx, async (db) => {
      const r = await db.query<{ id: string }>(
        'SELECT app.deliver_sales_order($1, $2::jsonb, $3) AS id', [orderId, JSON.stringify(b.lines), b.clientOpId]);
      const d = await db.query(
        `SELECT id, number, sales_order_id AS "salesOrderId", invoice_id AS "invoiceId", delivered_at AS "deliveredAt"
           FROM app.sales_deliveries WHERE id = $1`, [r.rows[0].id]);
      return d.rows[0];
    });
  }

  invoiceDelivery(ctx: RequestContext, deliveryId: string) {
    return this.run(ctx, async (db) => {
      const r = await db.query<{ id: string }>('SELECT app.invoice_delivery($1) AS id', [deliveryId]);
      return this.loadInvoiceSummary(db, r.rows[0].id);
    });
  }

  creditNote(ctx: RequestContext, invoiceId: string, b: CreditNoteCreate) {
    return this.run(ctx, async (db) => {
      const r = await db.query<{ id: string }>('SELECT app.create_credit_note($1, $2) AS id', [invoiceId, b.reason]);
      return this.loadInvoiceSummary(db, r.rows[0].id);
    });
  }

  // ---------------------------------------------------------------------------
  // Druckdokumente (HTML, zweisprachig) – Daten ausschließlich aus der Datenbank
  // ---------------------------------------------------------------------------
  invoiceDocument(ctx: RequestContext, invoiceId: string): Promise<string> {
    return this.run(ctx, async (db) => {
      const r = await db.query(
        `SELECT i.number, i.status, i.is_credit_note AS "isCreditNote", i.issue_date::text AS "issueDate",
                i.due_date::text AS "dueDate", i.currency, cur.minor_unit AS "minorDigits",
                i.net_total::text AS net, i.tax_total::text AS tax, i.stamp_duty::text AS stamp,
                i.gross_total::text AS gross, i.tax_breakdown AS breakdown,
                i.seller_snapshot AS seller, i.customer_snapshot AS customer,
                coalesce(ref.number, o.number) AS reference
           FROM app.sales_invoices i
           JOIN app.currencies cur ON cur.code = i.currency
           LEFT JOIN app.sales_invoices ref ON ref.id = i.credit_note_for
           LEFT JOIN app.sales_orders o ON o.id = i.sales_order_id
          WHERE i.id = $1`, [invoiceId]);
      const inv = r.rows[0];
      if (!inv) throw new NotFoundException('Rechnung nicht gefunden');
      if (inv.status === 'draft') throw new ConflictException('Entwürfe werden nicht gedruckt – zuerst ausstellen');
      const lines = await db.query(
        `SELECT description, quantity::text AS quantity, unit_price::text AS "unitPrice", discount_bp AS "discountBp",
                tax_rate_bp AS "taxRateBp", line_net::text AS "lineNet"
           FROM app.sales_invoice_lines WHERE invoice_id = $1 ORDER BY line_no`, [invoiceId]);
      return renderSalesDocument({
        kind: inv.isCreditNote ? 'credit_note' : 'invoice',
        number: inv.number, date: inv.issueDate, dueDate: inv.isCreditNote ? null : inv.dueDate,
        reference: inv.reference, currency: inv.currency, minorDigits: inv.minorDigits,
        seller: snapshotParty(inv.seller), customer: snapshotParty(inv.customer),
        lines: lines.rows,
        totals: {
          net: inv.net, tax: inv.tax, stamp: inv.stamp, gross: inv.gross,
          breakdown: (inv.breakdown as Array<{ rate_bp: number; net: number | string; tax: number | string }>)
            .map((b) => ({ rateBp: b.rate_bp, net: String(b.net), tax: String(b.tax) })),
        },
      });
    });
  }

  deliveryDocument(ctx: RequestContext, deliveryId: string): Promise<string> {
    return this.run(ctx, async (db) => {
      const r = await db.query(
        `SELECT d.number, d.delivered_at::date::text AS date, o.number AS "orderNumber", o.currency,
                coalesce(t.legal_name, t.name) AS "sellerName", t.tax_id AS "sellerTaxId",
                coalesce(c.legal_name, c.name) AS "customerName", c.tax_id AS "customerTaxId",
                c.billing_address AS "customerAddress", c.preferred_locale AS locale
           FROM app.sales_deliveries d
           JOIN app.sales_orders o ON o.id = d.sales_order_id
           JOIN app.customers c    ON c.id = o.customer_id
           JOIN app.tenants t      ON t.id = d.tenant_id
          WHERE d.id = $1`, [deliveryId]);
      const d = r.rows[0];
      if (!d) throw new NotFoundException('Lieferschein nicht gefunden');
      const lines = await db.query(
        `SELECT app.product_label(p.name, $2) AS description, dl.quantity::text AS quantity
           FROM app.sales_delivery_lines dl
           JOIN app.sales_order_lines ol ON ol.id = dl.order_line_id
           JOIN app.products p ON p.id = dl.product_id
          WHERE dl.delivery_id = $1 ORDER BY ol.line_no`, [deliveryId, d.locale]);
      return renderSalesDocument({
        kind: 'delivery', number: d.number, date: d.date, reference: d.orderNumber,
        currency: d.currency, minorDigits: 3,
        seller: { name: d.sellerName, taxId: d.sellerTaxId },
        customer: { name: d.customerName, taxId: d.customerTaxId, address: addressText(d.customerAddress) },
        lines: lines.rows,
      });
    });
  }

  // ---------------------------------------------------------------------------
  private async loadOrder(db: PoolClient, id: string) {
    const o = await db.query(
      `SELECT o.id, o.number, o.status, o.store_id AS "storeId", o.customer_id AS "customerId", o.currency,
              o.requested_date::text AS "requestedDate", o.note, o.confirmed_at AS "confirmedAt",
              o.credit_override_reason AS "creditOverrideReason", app.sales_order_gross(o.id)::text AS "estimatedGross"
         FROM app.sales_orders o WHERE o.id = $1`, [id]);
    if (!o.rows[0]) throw new NotFoundException('Auftrag nicht gefunden');
    const lines = await db.query(
      `SELECT id, line_no AS "lineNo", product_id AS "productId", packaging_id AS "packagingId",
              quantity::text AS quantity, quantity_delivered::text AS "quantityDelivered",
              unit_price::text AS "unitPrice", discount_bp AS "discountBp", tax_rate_bp AS "taxRateBp"
         FROM app.sales_order_lines WHERE sales_order_id = $1 ORDER BY line_no`, [id]);
    const deliveries = await db.query(
      `SELECT id, number, invoice_id AS "invoiceId", delivered_at AS "deliveredAt"
         FROM app.sales_deliveries WHERE sales_order_id = $1 ORDER BY delivered_at`, [id]);
    return { ...o.rows[0], lines: lines.rows, deliveries: deliveries.rows };
  }

  private async loadInvoiceSummary(db: PoolClient, id: string) {
    const r = await db.query(
      `SELECT id, number, status, is_credit_note AS "isCreditNote", credit_note_for AS "creditNoteFor",
              issue_date::text AS "issueDate", due_date::text AS "dueDate", currency,
              net_total::text AS "netTotal", tax_total::text AS "taxTotal", stamp_duty::text AS "stampDuty",
              gross_total::text AS "grossTotal", tax_breakdown AS "taxBreakdown"
         FROM app.sales_invoices WHERE id = $1`, [id]);
    return r.rows[0];
  }

  /** Transaktion mit Mandantenkontext + Übersetzung der Datenbank-Fehlercodes in HTTP-Status. */
  private async run<T>(ctx: RequestContext, fn: (db: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.db.withTenant(ctx, fn);
    } catch (e: unknown) {
      if (e instanceof HttpException) throw e;
      const err = e as { code?: string; message?: string; hint?: string };
      switch (err.code) {
        case 'SN402': throw new ConflictException({ message: err.message, hint: err.hint, code: 'CREDIT_LIMIT' });
        case 'SN422': throw new UnprocessableEntityException(err.message);
        case '23514': throw new ConflictException(err.message);            // Kreditlimit bei Rechnungsausstellung
        case 'P0002': throw new NotFoundException(err.message);            // no_data_found
        case '42501': throw new ForbiddenException('Keine Berechtigung für diese Filiale oder Aktion');
        case '22P02': throw new UnprocessableEntityException('Ungültige Eingabe');
        case '23503': throw new UnprocessableEntityException('Verweis ungültig (Filiale, Kunde oder Produkt)');
        default: throw e;
      }
    }
  }
}

function addressText(a: unknown): string | null {
  if (!a || typeof a !== 'object') return null;
  const parts = Object.values(a as Record<string, unknown>).filter((v) => typeof v === 'string' && v.trim());
  return parts.length ? parts.join(', ') : null;
}

function snapshotParty(s: { name?: string; tax_id?: string | null; address?: unknown } | null): DocumentParty {
  return { name: s?.name ?? '', taxId: s?.tax_id ?? null, address: addressText(s?.address) };
}
