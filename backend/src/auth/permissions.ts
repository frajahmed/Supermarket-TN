import { UserRole } from './request-context';

/**
 * Rechte-Katalog – Spiegel von app.permissions / app.role_permissions im Schema.
 * Code prüft immer Rechte, nie Rollennamen. Die DB-Policies sind die zweite Linie.
 */
export const PERMISSIONS = [
  'tenant.settings', 'user.manage', 'report.finance', 'report.stock',
  'product.write', 'price.update', 'stock.receive', 'stock.adjust', 'stock.read',
  'purchase.order', 'document.scan', 'sale.create', 'sale.void',
  'discount.approve', 'export.accounting', 'device.manage',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const ROLE_PERMISSIONS: Record<UserRole, ReadonlySet<Permission>> = {
  owner: new Set(PERMISSIONS),
  manager: new Set<Permission>([
    'user.manage', 'report.finance', 'report.stock', 'product.write', 'price.update',
    'stock.receive', 'stock.adjust', 'stock.read', 'purchase.order', 'document.scan',
    'sale.create', 'sale.void', 'discount.approve', 'export.accounting', 'device.manage',
  ]),
  stock_clerk: new Set<Permission>([
    'product.write', 'stock.receive', 'stock.adjust', 'stock.read', 'document.scan',
  ]),
  cashier: new Set<Permission>(['sale.create', 'stock.read']),
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role].has(permission);
}

/** Welche Bewegungsarten eine Rolle buchen darf (entspricht Policy movements_insert). */
export const MOVEMENT_PERMISSION = {
  purchase_receipt: 'stock.receive',
  supplier_return: 'stock.receive',
  transfer_in: 'stock.receive',
  transfer_out: 'stock.adjust',
  adjustment: 'stock.adjust',
  loss: 'stock.adjust',
  inventory_count: 'stock.adjust',
  sale: 'sale.create',
  customer_return: 'sale.create',
} as const satisfies Record<string, Permission>;

export type MovementType = keyof typeof MOVEMENT_PERMISSION;
