import type { LicenseMode } from './license.ts';

// Kacheln folgen den Rechten aus GET /me, nicht dem Rollennamen.
export interface Profile {
  user: { id: string; email: string; displayName: string; role: 'owner' | 'manager' | 'stock_clerk' | 'cashier'; totpConfigured: boolean };
  permissions: string[];
  stores: Array<{ id: string; code: string; name: string }>;
  license: { mode: LicenseMode; reason?: string };
}

export type HomeTile = 'products' | 'customers' | 'orders' | 'warehouse' | 'payments' | 'pos' | 'users' | 'devices';

const TILE_RULES: ReadonlyArray<[HomeTile, (p: ReadonlySet<string>) => boolean]> = [
  ['orders', (p) => p.has('sales.order')],
  ['products', (p) => p.has('stock.read')],
  ['customers', (p) => p.has('customer.manage') || p.has('sales.order')],
  ['warehouse', (p) => p.has('stock.receive') || p.has('stock.adjust')],
  ['payments', (p) => p.has('payment.record')],
  ['pos', (p) => p.has('sale.create')],
  ['users', (p) => p.has('user.manage')],
  ['devices', (p) => p.has('device.manage')],
];

/** null = Bereich noch im Bau. */
export function tileRoute(tile: HomeTile): string | null {
  const routes: Partial<Record<HomeTile, string>> = { products: '/products', customers: '/customers', orders: '/orders', warehouse: '/warehouse', pos: '/pos',
    users: '/users', devices: '/devices' };
  return routes[tile] ?? null;
}

export function tilesFor(permissions: readonly string[]): HomeTile[] {
  const set = new Set(permissions);
  return TILE_RULES.filter(([, allowed]) => allowed(set)).map(([tile]) => tile);
}

export function licenseAllowsWrite(mode: LicenseMode): boolean {
  return mode === 'active' || mode === 'warning';
}

export function licenseBannerColor(mode: LicenseMode): { background: string; text: string } | null {
  if (mode === 'warning') return { background: '#fdf2c8', text: '#7a5b00' };
  if (mode === 'read_only' || mode === 'unlicensed') return { background: '#fde2e1', text: '#9b1c15' };
  return null;
}

/** Gespeicherte Filiale nur übernehmen, wenn der Nutzer noch Zugriff hat. */
export function pickStore(stores: ReadonlyArray<{ id: string }>, saved: string | null): string | null {
  if (saved && stores.some((s) => s.id === saved)) return saved;
  return stores[0]?.id ?? null;
}
