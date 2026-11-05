import { z } from 'zod';

const movementTypes = [
  'purchase_receipt', 'sale', 'customer_return', 'supplier_return', 'adjustment',
  'loss', 'transfer_out', 'transfer_in', 'inventory_count',
] as const;

/** Eine vom Gerät (ggf. offline) erzeugte Bestandsbewegung. */
export const MovementInput = z.object({
  clientOpId: z.string().uuid(),             // vom Gerät erzeugt (UUID v7) -> Idempotenz
  storeId: z.string().uuid(),
  productId: z.string().uuid(),
  lotId: z.string().uuid().optional(),
  /** Der Server sucht die Charge oder legt sie an – anlegen nur bei Zugang. */
  lot: z.object({
    lotNumber: z.string().trim().min(1).max(100).optional(),
    expiryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, 'MHD als JJJJ-MM-TT'),
  }).strict().optional(),
  type: z.enum(movementTypes),
  // Als String, damit Mengen wie "0.250" (kg) ohne Float-Fehler ankommen
  quantityDelta: z.string().regex(/^-?\d{1,11}(\.\d{1,3})?$/),
  unitCost: z.string().regex(/^\d+$/).optional(),   // Minor Units
  reason: z.string().max(500).optional(),
  refType: z.enum(['sale', 'document', 'purchase_order', 'transfer', 'count']).optional(),
  refId: z.string().uuid().optional(),
  occurredAt: z.string().datetime({ offset: true }),
}).refine((m) => !(m.lot && m.lotId), { message: 'lot und lotId schließen sich aus', path: ['lot'] });
export type MovementInput = z.infer<typeof MovementInput>;

/** POST /sync/push – Stapel aus der Offline-Queue eines Geräts. */
export const PushRequest = z.object({
  movements: z.array(MovementInput).min(1).max(500),
});
export type PushRequest = z.infer<typeof PushRequest>;

export const PullQuery = z.object({
  storeId: z.string().uuid(),
  since: z.coerce.number().int().min(0).default(0),  // letzter bekannter Journal-Cursor
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});
export type PullQuery = z.infer<typeof PullQuery>;

export type PushResultItem =
  | { clientOpId: string; status: 'accepted'; movementId: string }
  | { clientOpId: string; status: 'duplicate' }
  | { clientOpId: string; status: 'rejected'; error: string };

export const StockQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().trim().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  low: z.enum(['true', 'false']).optional(),
  /** Präfix von store_products.shelf_location (Inventur je Regal) */
  location: z.string().trim().min(1).max(50).optional(),
});
export type StockQuery = z.infer<typeof StockQuery>;
