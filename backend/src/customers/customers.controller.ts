import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Ctx, RequirePermission } from '../auth/auth.guard';
import { RequestContext } from '../auth/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { CustomerCreate, CustomerPatch, CustomerQuery } from './customers.dto';
import { CustomersService } from './customers.service';

/**
 * Geschäftskunden (T-111). Lesen: wer Aufträge erfasst (`sales.order`, auch Lagerist);
 * Schreiben: `customer.manage` (Inhaber, Filialleiter). Kassierer: kein Zugriff.
 */
@Controller('customers')
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get()
  @RequirePermission('sales.order')
  list(@Ctx() ctx: RequestContext, @Query(new ZodPipe(CustomerQuery)) q: CustomerQuery) {
    return this.customers.list(ctx, q);
  }

  @Get(':id')
  @RequirePermission('sales.order')
  detail(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.detail(ctx, id);
  }

  @Post()
  @RequirePermission('customer.manage')
  create(@Ctx() ctx: RequestContext, @Body(new ZodPipe(CustomerCreate)) body: CustomerCreate) {
    return this.customers.create(ctx, body);
  }

  @Patch(':id')
  @RequirePermission('customer.manage')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CustomerPatch)) body: CustomerPatch) {
    return this.customers.update(ctx, id, body);
  }
}
