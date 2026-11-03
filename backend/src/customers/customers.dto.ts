import { z } from 'zod';

/**
 * Matricule fiscal (Tunesien): 7 Ziffern + Kontrollbuchstabe, optional gefolgt von
 * TVA-Code, Kategorie und Betriebsnummer (z. B. 1234567A/M/A/000 oder 3333333C/A/000).
 * Gespeichert wird in Großbuchstaben ohne Leerzeichen.
 */
export const TAX_ID_MESSAGE = 'Matricule fiscal ist für Geschäftskunden Pflicht (Format z. B. 1234567A/M/A/000)';
export const TAX_ID_FORMAT_MESSAGE = 'Matricule fiscal ungültig – erwartet 7 Ziffern und einen Buchstaben, z. B. 1234567A/M/A/000';

export function normalizeTaxId(value: string): string {
  return value.replace(/\s+/gu, '').toUpperCase();
}

export function isValidTaxId(value: string): boolean {
  return /^\d{7}[A-Z](?:[/.-]?[A-Z0-9]{1,3}){0,4}$/u.test(value);
}

const taxId = z.string().trim().max(40).transform(normalizeTaxId)
  .refine(isValidTaxId, { message: TAX_ID_FORMAT_MESSAGE });
const money = z.string().regex(/^\d{1,15}$/u, 'Betrag in Minor Units (Millimes)');
const address = z.object({
  street: z.string().trim().max(200).optional(),
  city: z.string().trim().max(100).optional(),
  postalCode: z.string().trim().max(20).optional(),
  governorate: z.string().trim().max(100).optional(),
  country: z.string().trim().length(2).optional(),
}).strict();

const fields = {
  number: z.string().trim().min(1).max(50),
  type: z.enum(['business', 'individual']),
  name: z.string().trim().min(1).max(200),
  legalName: z.string().trim().max(200).nullable(),
  taxId: taxId.nullable(),
  vatExempt: z.boolean(),
  groupId: z.string().uuid().nullable(),
  priceListId: z.string().uuid().nullable(),
  paymentTermsDays: z.number().int().min(0).max(365),
  creditLimit: money.nullable(),          // null = kein Limit
  phone: z.string().trim().max(40).nullable(),
  email: z.string().trim().email().max(200).nullable(),
  billingAddress: address,
  preferredLocale: z.enum(['fr-TN', 'ar-TN', 'en']),
  isActive: z.boolean(),
};

export const CustomerCreate = z.object({
  ...fields,
  number: fields.number.optional(),       // leer -> automatisch CL-JJJJ-NNNNNN
  type: fields.type.default('business'),
}).partial({
  legalName: true, taxId: true, vatExempt: true, groupId: true, priceListId: true, paymentTermsDays: true,
  creditLimit: true, phone: true, email: true, billingAddress: true, preferredLocale: true, isActive: true,
}).strict().superRefine((c, ctx) => {
  if (c.type === 'business' && !c.taxId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['taxId'], message: TAX_ID_MESSAGE });
});
export type CustomerCreate = z.infer<typeof CustomerCreate>;

export const CustomerPatch = z.object(fields).partial().strict()
  .refine((b) => Object.keys(b).length > 0, { message: 'Mindestens ein Feld ist erforderlich' });
export type CustomerPatch = z.infer<typeof CustomerPatch>;

export const CustomerQuery = z.object({
  q: z.string().trim().min(1).max(100).optional(),
  cursor: z.string().trim().max(400).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  includeInactive: z.enum(['true', 'false']).optional(),
}).strict();
export type CustomerQuery = z.infer<typeof CustomerQuery>;
