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

/** Inhalt des Access-Tokens (JWT, 15 Minuten gültig, signiert vom Kundenserver). */
export interface AccessTokenClaims {
  sub: string;     // Benutzer-ID
  tid: string;     // Mandant
  role: UserRole;
  did: string;     // freigeschaltetes Gerät (Pflicht)
}
