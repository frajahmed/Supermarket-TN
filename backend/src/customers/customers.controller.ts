import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { Ctx, RequirePermission } from '../auth/auth.guard';
import { RequestContext } from '../auth/request-context';
import { ZodPipe } from '../common/zod.pipe';
import {
  CustomerCreate, CustomerPatch, CustomerQuery, PaymentCreate, PaymentReverse, StatementQuery,
} from './customers.dto';
import { CustomersService } from './customers.service';

/**
 * Geschäftskunden (T-111). Lesen: wer Aufträge erfasst (`sales.order`, auch Lagerist);
 * Schreiben: `customer.manage` (Inhaber, Filialleiter). Kassierer: kein Zugriff.
 */
@Controller()
export class CustomersController {
  constructor(private readonly customers: CustomersService) {}

  @Get('customers')
  @RequirePermission('sales.order')
  list(@Ctx() ctx: RequestContext, @Query(new ZodPipe(CustomerQuery)) q: CustomerQuery) {
    return this.customers.list(ctx, q);
  }

  @Get('customers/:id')
  @RequirePermission('sales.order')
  detail(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.customers.detail(ctx, id);
  }

  @Post('customers')
  @RequirePermission('customer.manage')
  create(@Ctx() ctx: RequestContext, @Body(new ZodPipe(CustomerCreate)) body: CustomerCreate) {
    return this.customers.create(ctx, body);
  }

  @Patch('customers/:id')
  @RequirePermission('customer.manage')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CustomerPatch)) body: CustomerPatch) {
    return this.customers.update(ctx, id, body);
  }

  /** Zahlung erfassen (bar, Scheck, Überweisung, Traite …); idempotent über clientOpId (T-114). */
  @Post('customers/:id/payments')
  @RequirePermission('payment.record')
  pay(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(PaymentCreate)) body: PaymentCreate) {
    return this.customers.recordPayment(ctx, id, body);
  }

  /** Storno als Gegenbuchung mit Begründung – Zahlungen selbst sind unveränderlich. */
  @Post('payments/:id/reversal')
  @RequirePermission('payment.record')
  reverse(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(PaymentReverse)) body: PaymentReverse) {
    return this.customers.reversePayment(ctx, id, body);
  }

  @Get('customers/:id/statement')
  @RequirePermission('sales.order')
  statement(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(StatementQuery)) q: StatementQuery) {
    return this.customers.statement(ctx, id, q);
  }

  @Get('customers/:id/statement/document')
  @RequirePermission('sales.order')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('x-content-type-options', 'nosniff')
  @Header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
  statementDocument(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string,
    @Query(new ZodPipe(StatementQuery)) q: StatementQuery) {
    return this.customers.statementDocument(ctx, id, q);
  }
}
