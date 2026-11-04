import {
  BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable, NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PoolClient } from 'pg';
import { RequestContext } from '../auth/request-context';
import { DbService } from '../db/db.service';
import { renderStatement, type LedgerKind } from '../core/statement-document.ts';
import {
  CustomerCreate, CustomerPatch, CustomerQuery, PaymentCreate, PaymentReverse, StatementQuery, TAX_ID_MESSAGE,
} from './customers.dto';

const COLUMNS = `
  c.id, c.number, c.type, c.name, c.legal_name AS "legalName", c.tax_id AS "taxId", c.vat_exempt AS "vatExempt",
  c.group_id AS "groupId", c.price_list_id AS "priceListId", c.currency, c.payment_terms_days AS "paymentTermsDays",
  c.credit_limit::text AS "creditLimit", c.phone, c.email::text AS email, c.billing_address AS "billingAddress",
  c.preferred_locale AS "preferredLocale", c.is_active AS "isActive",
  app.customer_open_balance(c.id)::text AS "openBalance"`;

/** Spaltenname je Feld des API-Modells (nur diese dürfen geschrieben werden). */
const COLUMN_OF: Record<string, string> = {
  number: 'number', type: 'type', name: 'name', legalName: 'legal_name', taxId: 'tax_id', vatExempt: 'vat_exempt',
  groupId: 'group_id', priceListId: 'price_list_id', paymentTermsDays: 'payment_terms_days', creditLimit: 'credit_limit',
  phone: 'phone', email: 'email', billingAddress: 'billing_address', preferredLocale: 'preferred_locale', isActive: 'is_active',
};

type Row = Record<string, unknown> & {
  id: string; number: string; name: string; taxId: string | null; creditLimit: string | null; openBalance: string;
};

function withLimitInfo(r: Row) {
  return { ...r, overLimit: r.creditLimit !== null && BigInt(r.openBalance) > BigInt(r.creditLimit) };
}

function pg(e: unknown): { code?: string; constraint?: string } {
  return typeof e === 'object' && e !== null ? e as { code?: string; constraint?: string } : {};
}

/** Datenbankfehler in verständliche HTTP-Antworten übersetzen. */
function mapError(e: unknown): never {
  const { code, constraint } = pg(e);
  if (code === '23505') throw new ConflictException('Kundennummer ist bereits vergeben');
  if (code === '23514' && constraint === 'customers_check') {
    throw new BadRequestException({ message: TAX_ID_MESSAGE, issues: [{ path: ['taxId'], message: TAX_ID_MESSAGE }] });
  }
  if (code === '23503') throw new BadRequestException('Kundengruppe oder Preisliste unbekannt');
  throw e;
}

function encodeCursor(c: { name: string; id: string }) {
  return Buffer.from(JSON.stringify(c), 'utf8').toString('base64url');
}

function decodeCursor(v: string | undefined): { name: string; id: string } | undefined {
  if (!v) return undefined;
  try {
    const c = JSON.parse(Buffer.from(v, 'base64url').toString('utf8')) as { name?: unknown; id?: unknown };
    if (typeof c.name !== 'string' || typeof c.id !== 'string' || !/^[0-9a-f-]{36}$/iu.test(c.id)) throw new Error('cursor');
    return { name: c.name, id: c.id };
  } catch {
    throw new BadRequestException('Cursor ungültig');
  }
}

@Injectable()
export class CustomersService {
  constructor(private readonly db: DbService) {}

  async list(ctx: RequestContext, q: CustomerQuery) {
    const cursor = decodeCursor(q.cursor);
    const like = q.q === undefined ? null : q.q.replace(/[\\%_]/g, '\\$&');
    return this.db.withTenant(ctx, async (db) => {
      const r = await db.query<Row>(
        `SELECT ${COLUMNS} FROM app.customers c
          WHERE ($1::text IS NULL OR c.name ILIKE '%' || $1 || '%' ESCAPE E'\\\\'
                 OR c.number ILIKE '%' || $1 || '%' ESCAPE E'\\\\'
                 OR c.tax_id ILIKE '%' || $1 || '%' ESCAPE E'\\\\')
            AND ($2::boolean OR c.is_active)
            AND ($3::text IS NULL OR (c.name, c.id) > ($3::text, $4::uuid))
          ORDER BY c.name, c.id
          LIMIT $5`,
        [like, q.includeInactive === 'true', cursor?.name ?? null, cursor?.id ?? null, q.limit + 1]);
      const items = r.rows.slice(0, q.limit);
      const last = items.at(-1);
      return {
        items: items.map(withLimitInfo),
        nextCursor: r.rows.length > q.limit && last ? encodeCursor({ name: last.name, id: last.id }) : null,
      };
    });
  }

  /** Kundendetail: Stammdaten, Saldo/Limit, letzte Aufträge und Rechnungen. */
  async detail(ctx: RequestContext, id: string) {
    return this.db.withTenant(ctx, async (db) => {
      const customer = await this.require(db, id);
      const [orders, invoices, groups, payments] = await Promise.all([
        db.query(
          `SELECT o.id, o.number, o.status, o.created_at AS "createdAt", app.sales_order_gross(o.id)::text AS "grossTotal"
             FROM app.sales_orders o WHERE o.customer_id = $1 ORDER BY o.created_at DESC LIMIT 5`, [id]),
        db.query(
          `SELECT i.id, i.number, i.status, i.is_credit_note AS "isCreditNote", i.issue_date::text AS "issueDate",
                  i.due_date::text AS "dueDate", i.gross_total::text AS "grossTotal"
             FROM app.sales_invoices i WHERE i.customer_id = $1 AND i.status <> 'draft'
            ORDER BY i.issue_date DESC NULLS LAST, i.number DESC LIMIT 5`, [id]),
        db.query(`SELECT name FROM app.customer_groups WHERE id = $1`, [customer.groupId ?? null]),
        db.query(
          `SELECT p.id, p.amount::text AS amount, p.method, p.reference, p.received_at::text AS "receivedAt",
                  p.reverses_payment_id AS "reversesPaymentId", p.reason,
                  EXISTS (SELECT 1 FROM app.customer_payments r WHERE r.reverses_payment_id = p.id) AS reversed
             FROM app.customer_payments p WHERE p.customer_id = $1 ORDER BY p.created_at DESC LIMIT 5`, [id]),
      ]);
      return {
        customer: withLimitInfo(customer),
        groupName: groups.rows[0]?.name ?? null,
        recentOrders: orders.rows,
        recentInvoices: invoices.rows,
        recentPayments: payments.rows,
      };
    });
  }

  async create(ctx: RequestContext, body: CustomerCreate) {
    return this.db.withTenant(ctx, async (db) => {
      const number = body.number ?? (await db.query<{ n: string }>(`SELECT app.next_document_number('CL') AS n`)).rows[0].n;
      const values: Record<string, unknown> = { ...body, number };
      const keys = Object.keys(values).filter((k) => COLUMN_OF[k] && values[k] !== undefined);
      try {
        const r = await db.query<{ id: string }>(
          `INSERT INTO app.customers (tenant_id, ${keys.map((k) => COLUMN_OF[k]).join(', ')})
           VALUES ($1, ${keys.map((k, i) => (k === 'billingAddress' ? `$${i + 2}::jsonb` : `$${i + 2}`)).join(', ')})
           RETURNING id`,
          [ctx.tenantId, ...keys.map((k) => (k === 'billingAddress' ? JSON.stringify(values[k]) : values[k]))]);
        const created = await this.require(db, r.rows[0].id);
        await this.audit(db, ctx, 'customer.create', created.id, null, created);
        return withLimitInfo(created);
      } catch (e) {
        mapError(e);
      }
    });
  }

  async update(ctx: RequestContext, id: string, body: CustomerPatch) {
    return this.db.withTenant(ctx, async (db) => {
      const before = await this.require(db, id);
      const keys = Object.keys(body).filter((k) => COLUMN_OF[k]);
      const vals = keys.map((k) => (k === 'billingAddress' ? JSON.stringify((body as Record<string, unknown>)[k])
        : (body as Record<string, unknown>)[k]));
      try {
        await db.query(
          `UPDATE app.customers SET ${keys.map((k, i) => `${COLUMN_OF[k]} = $${i + 2}${k === 'billingAddress' ? '::jsonb' : ''}`).join(', ')},
                  updated_at = now()
            WHERE id = $1`, [id, ...vals]);
      } catch (e) {
        mapError(e);
      }
      const after = await this.require(db, id);
      // Kreditlimit und Zahlungsziel sind finanzrelevant -> eigener Audit-Eintrag
      const action = 'creditLimit' in body || 'paymentTermsDays' in body ? 'customer.credit_update' : 'customer.update';
      await this.audit(db, ctx, action, id, before, after);
      return withLimitInfo(after);
    });
  }

  // ---------------------------------------------------------------------------
  // Zahlungen und Kontoauszug (T-114) – Regeln in db/009_payments.sql
  // ---------------------------------------------------------------------------
  async recordPayment(ctx: RequestContext, customerId: string, b: PaymentCreate) {
    return this.payments(ctx, async (db) => {
      const r = await db.query<{ id: string }>(
        'SELECT app.record_payment($1, $2::bigint, $3, $4, $5::date, $6, $7) AS id',
        [customerId, b.amount, b.method, b.reference ?? null, b.receivedAt ?? null, b.invoiceId ?? null, b.clientOpId]);
      return this.paymentWithBalance(db, r.rows[0].id);
    });
  }

  async reversePayment(ctx: RequestContext, paymentId: string, b: PaymentReverse) {
    return this.payments(ctx, async (db) => {
      const r = await db.query<{ id: string }>('SELECT app.reverse_payment($1, $2, $3) AS id', [paymentId, b.reason, b.clientOpId]);
      return this.paymentWithBalance(db, r.rows[0].id);
    });
  }

  /**
   * Kontoauszug: Anfangssaldo (Buchungen vor `from`), Buchungen im Zeitraum mit laufendem Saldo,
   * Schlusssaldo. Ohne `to` (bis heute) entspricht der Schlusssaldo dem offenen Saldo.
   */
  async statement(ctx: RequestContext, customerId: string, q: StatementQuery) {
    return this.db.withTenant(ctx, async (db) => this.loadStatement(db, customerId, q));
  }

  async statementDocument(ctx: RequestContext, customerId: string, q: StatementQuery): Promise<string> {
    return this.db.withTenant(ctx, async (db) => {
      const st = await this.loadStatement(db, customerId, q);
      const seller = (await db.query<{ name: string; taxId: string | null }>(
        `SELECT coalesce(legal_name, name) AS name, tax_id AS "taxId" FROM app.tenants WHERE id = $1`, [ctx.tenantId])).rows[0];
      return renderStatement({
        seller: seller ?? { name: '', taxId: null },
        customer: { name: st.customer.name, number: st.customer.number, taxId: st.customer.taxId },
        from: st.from, to: st.to, currency: 'TND', minorDigits: 3,
        opening: st.opening, closing: st.closing,
        entries: st.entries.map((e) => ({ date: e.date, kind: e.kind, number: e.number, reference: e.reference,
          amount: e.amount, balance: e.balance })),
      });
    });
  }

  private async loadStatement(db: PoolClient, customerId: string, q: StatementQuery) {
    const customer = await this.require(db, customerId);
    const to = q.to ?? (await db.query<{ d: string }>('SELECT current_date::text AS d')).rows[0].d;
    const opening = q.from
      ? (await db.query<{ s: string }>(
        `SELECT coalesce(sum(amount), 0)::text AS s FROM app.customer_ledger($1) WHERE entry_date < $2::date`,
        [customerId, q.from])).rows[0].s
      : '0';
    const rows = await db.query<{ date: string; kind: LedgerKind; documentId: string; number: string | null;
      reference: string | null; amount: string; reversed: boolean }>(
      `SELECT l.entry_date::text AS date, l.kind, l.document_id AS "documentId", l.number, l.reference, l.amount::text AS amount,
              (l.kind = 'payment' AND EXISTS (SELECT 1 FROM app.customer_payments r WHERE r.reverses_payment_id = l.document_id)) AS reversed
         FROM app.customer_ledger($1) l
        WHERE ($2::date IS NULL OR l.entry_date >= $2::date) AND l.entry_date <= $3::date
        ORDER BY l.entry_date, l.created_at, l.document_id`, [customerId, q.from ?? null, to]);
    let balance = BigInt(opening);
    const entries = rows.rows.map((r) => {
      balance += BigInt(r.amount);
      return { ...r, balance: balance.toString() };
    });
    return {
      customer: withLimitInfo(customer), from: q.from ?? null, to, opening, closing: balance.toString(), entries,
    };
  }

  private async paymentWithBalance(db: PoolClient, id: string) {
    const r = await db.query(
      `SELECT p.id, p.customer_id AS "customerId", p.invoice_id AS "invoiceId", p.amount::text AS amount, p.method,
              p.reference, p.received_at::text AS "receivedAt", p.reverses_payment_id AS "reversesPaymentId", p.reason,
              app.customer_open_balance(p.customer_id)::text AS "openBalance"
         FROM app.customer_payments p WHERE p.id = $1`, [id]);
    return r.rows[0];
  }

  /** Mandantenkontext + Übersetzung der Fehlercodes aus 009. */
  private async payments<T>(ctx: RequestContext, fn: (db: PoolClient) => Promise<T>): Promise<T> {
    try {
      return await this.db.withTenant(ctx, fn);
    } catch (e: unknown) {
      if (e instanceof HttpException) throw e;
      const err = e as { code?: string; message?: string };
      switch (err.code) {
        case 'SN409': throw new ConflictException(err.message);
        case 'SN422': throw new UnprocessableEntityException(err.message);
        case 'P0002': throw new NotFoundException(err.message);
        case '42501': throw new ForbiddenException('Keine Berechtigung, Zahlungen zu erfassen');
        case '23503': throw new UnprocessableEntityException('Kunde oder Rechnung unbekannt');
        default: throw e;
      }
    }
  }

  private async require(db: PoolClient, id: string): Promise<Row> {
    const r = await db.query<Row>(`SELECT ${COLUMNS} FROM app.customers c WHERE c.id = $1`, [id]);
    if (!r.rows[0]) throw new NotFoundException('Kunde nicht gefunden');
    return r.rows[0];
  }

  private async audit(db: PoolClient, ctx: RequestContext, action: string, id: string, before: unknown, after: unknown) {
    await db.query(
      `INSERT INTO app.audit_log (tenant_id, user_id, action, entity_type, entity_id, before, after)
       VALUES ($1, $2, $3, 'customer', $4, $5::jsonb, $6::jsonb)`,
      [ctx.tenantId, ctx.userId, action, id, before === null ? null : JSON.stringify(before), JSON.stringify(after)]);
  }
}
