import { z } from 'zod';

export const DevicePatch = z.object({
  name: z.string().trim().min(1).max(100).optional(),
  storeId: z.string().uuid().nullable().optional(),
}).strict().refine((b) => Object.keys(b).length > 0, { message: 'Mindestens ein Feld ist erforderlich' });
export type DevicePatch = z.infer<typeof DevicePatch>;
