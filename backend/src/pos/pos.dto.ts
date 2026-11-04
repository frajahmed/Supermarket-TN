import { z } from 'zod';

const quantity = z.string().regex(/^\d{1,11}(\.\d{1,3})?$/u, 'Menge als Dezimaltext').refine((v) => /[1-9]/u.test(v), 'Menge > 0');
const minor = z.string().regex(/^[1-9]\d{0,14}$/u, 'Betrag in Millimes, größer als 0');

/** POST /pos/sales – Verkauf abschließen (T-115). */
export const SaleCreate = z.object({
  storeId: z.string().uuid(),
  clientOpId: z.string().uuid(),
  startedAt: z.string().datetime({ offset: true }).optional(),
  lines: z.array(z.object({
    productId: z.string().uuid(),
    quantity,
    discountBp: z.number().int().min(0).max(10000).optional(),
  }).strict()).min(1).max(300),
  payments: z.array(z.object({
    method: z.enum(['cash', 'card', 'voucher', 'other']),
    amount: minor,
    terminalRef: z.string().trim().max(100).optional(),
  }).strict()).min(1).max(5),
  /** Freigabe eines Rabatts über dem Kassierer-Limit: Inhaber/Filialleiter bestätigt am Gerät */
  approval: z.object({ email: z.string().trim().email().max(200), secret: z.string().min(1).max(200) }).strict().optional(),
}).strict();
export type SaleCreate = z.infer<typeof SaleCreate>;

export const SaleVoid = z.object({ reason: z.string().trim().min(3).max(500), clientOpId: z.string().uuid() }).strict();
export type SaleVoid = z.infer<typeof SaleVoid>;

export const SaleQuery = z.object({
  storeId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  mine: z.enum(['true', 'false']).optional(),
}).strict();
export type SaleQuery = z.infer<typeof SaleQuery>;
