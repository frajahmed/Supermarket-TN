export type UserRole = 'owner' | 'manager' | 'stock_clerk' | 'cashier';

/** Wird vom AuthGuard pro Request gebaut und an Services weitergereicht. */
export interface RequestContext {
  tenantId: string;
  userId: string;
  role: UserRole;
  /** Zugewiesene Filialen, frisch aus der DB geladen (nicht blind aus dem JWT). */
  storeIds: string[];
  deviceId?: string;
}

/** Inhalt des Access-Tokens (JWT, 15 Minuten gültig). */
export interface AccessTokenClaims {
  sub: string;     // user id
  tid: string;     // tenant id
  role: UserRole;
  did?: string;    // device id (gekoppeltes Gerät)
}
