import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Ctx, RequirePermission } from '../auth/auth.guard';
import { RequestContext } from '../auth/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { SaleCreate, SaleQuery, SaleVoid } from './pos.dto';
import { PosService } from './pos.service';

/** Kasse / Abholverkauf (T-115). Bonnummer lückenlos je Gerät, Storno als Gegenbon. */
@Controller('pos')
export class PosController {
  constructor(private readonly pos: PosService) {}

  @Get('config')
  @RequirePermission('sale.create')
  config(@Ctx() ctx: RequestContext) {
    return this.pos.config(ctx);
  }

  @Post('sales')
  @RequirePermission('sale.create')
  complete(@Ctx() ctx: RequestContext, @Body(new ZodPipe(SaleCreate)) body: SaleCreate) {
    return this.pos.complete(ctx, body);
  }

  @Get('sales')
  @RequirePermission('sale.create')
  list(@Ctx() ctx: RequestContext, @Query(new ZodPipe(SaleQuery)) q: SaleQuery) {
    return this.pos.list(ctx, q);
  }

  @Get('sales/:id')
  @RequirePermission('sale.create')
  get(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.pos.get(ctx, id);
  }

  @Get('sales/:id/receipt')
  @RequirePermission('sale.create')
  @Header('content-type', 'text/html; charset=utf-8')
  @Header('x-content-type-options', 'nosniff')
  @Header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
  receipt(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.pos.receipt(ctx, id);
  }

  @Post('sales/:id/void')
  @RequirePermission('sale.void')
  void(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(SaleVoid)) body: SaleVoid) {
    return this.pos.void(ctx, id, body);
  }
}
