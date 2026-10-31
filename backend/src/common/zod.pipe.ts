import { BadRequestException, PipeTransform } from '@nestjs/common';
import { ZodSchema } from 'zod';

/** Validiert Body/Query gegen ein Zod-Schema; Fehlermeldungen gehen strukturiert an den Client. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new BadRequestException({ message: 'Validierung fehlgeschlagen', issues: parsed.error.issues });
    }
    return parsed.data;
  }
}
