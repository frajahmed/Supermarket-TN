import { z } from 'zod';

const password = z.string().min(10, 'Passwort muss mindestens 10 Zeichen haben').max(200);
const pin = z.string().regex(/^\d{4,8}$/, 'PIN muss 4 bis 8 Ziffern haben');
const role = z.enum(['owner', 'manager', 'stock_clerk', 'cashier']);
const storeIds = z.array(z.string().uuid()).max(100);

export const UserCreate = z.object({
  email: z.string().email().max(200),
  displayName: z.string().trim().min(1).max(200),
  role,
  password: password.optional(),
  pin: pin.optional(),
  locale: z.enum(['ar-TN', 'fr-TN', 'en']).optional(),
  storeIds: storeIds.default([]),
}).strict();
export type UserCreate = z.infer<typeof UserCreate>;

export const UserPatch = z.object({
  displayName: z.string().trim().min(1).max(200).optional(),
  role: role.optional(),
  password: password.nullable().optional(),
  pin: pin.nullable().optional(),
  locale: z.enum(['ar-TN', 'fr-TN', 'en']).nullable().optional(),
  storeIds: storeIds.optional(),
  /** Nur Zurücksetzen (null). Einrichten macht jeder Nutzer selbst über /me/2fa. */
  totpSecret: z.null().optional(),
  isActive: z.boolean().optional(),
}).strict().refine((body) => Object.keys(body).length > 0, {
  message: 'Mindestens ein Feld ist erforderlich',
});
export type UserPatch = z.infer<typeof UserPatch>;

export const TotpConfirm = z.object({ code: z.string().regex(/^\d{6}$/, 'Code muss 6 Ziffern haben') }).strict();
export type TotpConfirm = z.infer<typeof TotpConfirm>;
