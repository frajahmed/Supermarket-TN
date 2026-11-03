import { z } from 'zod';

const quantity = z.string().regex(/^\d{1,11}(\.\d{1,3})?$/, 'Menge als Dezimaltext, max. 3 Nachkommastellen')
  .refine((v) => /[1-9]/.test(v), 'Menge muss größer als 0 sein');

export const SalesOrderCreate = z.object({
  storeId: z.string().uuid(),
  customerId: z.string().uuid(),
  lines: z.array(z.object({
    productId: z.string().uuid(),
    quantity,
    packagingId: z.string().uuid().optional(),
  }).strict()).min(1).max(500),
  requestedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().trim().max(1000).optional(),
  clientOpId: z.string().uuid().optional(),
}).strict();
export type SalesOrderCreate = z.infer<typeof SalesOrderCreate>;

export const SalesOrderConfirm = z.object({
  /** Nur der Inhaber: Begründung, um ein überschrittenes Kreditlimit zu übersteuern. */
  overrideReason: z.string().trim().min(3).max(500).optional(),
}).strict();
export type SalesOrderConfirm = z.infer<typeof SalesOrderConfirm>;

export const DeliveryCreate = z.object({
  clientOpId: z.string().uuid(),
  lines: z.array(z.object({ orderLineId: z.string().uuid(), quantity }).strict()).min(1).max(500),
}).strict();
export type DeliveryCreate = z.infer<typeof DeliveryCreate>;

export const CreditNoteCreate = z.object({ reason: z.string().trim().min(3).max(500) }).strict();
export type CreditNoteCreate = z.infer<typeof CreditNoteCreate>;

const cursor = z.string().trim().max(400).optional();

/** GET /sales-orders – Auftragsliste (T-112). */
export const SalesOrderQuery = z.object({
  status: z.enum(['draft', 'confirmed', 'delivered', 'invoiced', 'cancelled']).optional(),
  customerId: z.string().uuid().optional(),
  storeId: z.string().uuid().optional(),
  cursor,
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();
export type SalesOrderQuery = z.infer<typeof SalesOrderQuery>;

/** GET /invoices – Rechnungen und Gutschriften (T-112). Entwürfe erscheinen nicht. */
export const InvoiceQuery = z.object({
  status: z.enum(['issued', 'sent', 'accepted', 'rejected', 'cancelled']).optional(),
  customerId: z.string().uuid().optional(),
  cursor,
  limit: z.coerce.number().int().min(1).max(100).default(30),
}).strict();
export type InvoiceQuery = z.infer<typeof InvoiceQuery>;
