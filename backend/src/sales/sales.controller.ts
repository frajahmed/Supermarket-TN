import { Body, Controller, Get, Header, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Ctx, RequirePermission } from '../auth/auth.guard';
import { RequestContext } from '../auth/request-context';
import { ZodPipe } from '../common/zod.pipe';
import {
  CreditNoteCreate, DeliveryCreate, InvoiceQuery, SalesOrderConfirm, SalesOrderCreate, SalesOrderQuery,
} from './sales.dto';
import { SalesService } from './sales.service';

/** B2B-Verkauf: Auftrag -> Bestätigung -> Lieferung -> Rechnung -> Gutschrift (T-105). */
@Controller()
export class SalesController {
  constructor(private readonly sales: SalesService) {}

  @Post('sales-orders')
  @RequirePermission('sales.order')
  create(@Ctx() ctx: RequestContext, @Body(new ZodPipe(SalesOrderCreate)) body: SalesOrderCreate) {
    return this.sales.createOrder(ctx, body);
  }

  @Get('sales-orders')
  @RequirePermission('sales.order')
  list(@Ctx() ctx: RequestContext, @Query(new ZodPipe(SalesOrderQuery)) q: SalesOrderQuery) {
    return this.sales.listOrders(ctx, q);
  }

  @Get('invoices')
  @RequirePermission('sales.order')
  invoices(@Ctx() ctx: RequestContext, @Query(new ZodPipe(InvoiceQuery)) q: InvoiceQuery) {
    return this.sales.listInvoices(ctx, q);
  }

  @Get('invoices/:id')
  @RequirePermission('sales.order')
  invoiceDetail(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sales.getInvoice(ctx, id);
  }

  @Get('sales-orders/:id')
  @RequirePermission('stock.read')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sales.getOrder(ctx, id);
  }

  /** Prüft das Kreditlimit. Nur der Inhaber kann mit `overrideReason` übersteuern. */
  @Post('sales-orders/:id/confirm') @HttpCode(200)
  @RequirePermission('sales.order')
  confirm(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(SalesOrderConfirm)) body: SalesOrderConfirm) {
    return this.sales.confirmOrder(ctx, id, body);
  }

  /** Lieferung (auch Teillieferung): Lieferschein + Lagerbuchung; idempotent über clientOpId. */
  @Post('sales-orders/:id/deliveries')
  @RequirePermission('sales.order')
  deliver(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(DeliveryCreate)) body: DeliveryCreate) {
    return this.sales.deliver(ctx, id, body);
  }

  /** Rechnung über genau die Mengen dieser Lieferung; idempotent. */
  @Post('deliveries/:id/invoice')
  @RequirePermission('invoice.issue')
  invoice(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sales.invoiceDelivery(ctx, id);
  }

  @Post('invoices/:id/credit-note')
  @RequirePermission('invoice.issue')
  creditNote(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(CreditNoteCreate)) body: CreditNoteCreate) {
    return this.sales.creditNote(ctx, id, body);
  }

  /** Druckfertiges Dokument (A4, Französisch + Arabisch); PDF über Browser oder expo-print. */
  @Get('invoices/:id/document')
  @RequirePermission('stock.read')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('x-content-type-options', 'nosniff')
  @Header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
  invoiceDocument(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sales.invoiceDocument(ctx, id);
  }

  @Get('deliveries/:id/document')
  @RequirePermission('stock.read')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('x-content-type-options', 'nosniff')
  @Header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
  deliveryDocument(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sales.deliveryDocument(ctx, id);
  }
}
