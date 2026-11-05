import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Ctx, RequirePermission } from '../auth/auth.guard';
import { RequestContext } from '../auth/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { PullQuery, PushRequest, StockQuery } from './inventory.dto';
import { InventoryService } from './inventory.service';

/** Klare 403 statt leerer Liste; RLS würde ohnehin nichts liefern. */
export function assertStoreAccess(ctx: RequestContext, storeId: string) {
  if (ctx.role !== 'owner' && !ctx.storeIds.includes(storeId)) throw new ForbiddenException('Kein Zugriff auf diese Filiale');
}

@Controller()
export class InventoryController {
  constructor(private readonly inventory: InventoryService) {}

  /** Offline-Queue eines Geräts hochladen. Recht je Bewegungsart prüft der Service. */
  @Post('sync/push')
  @RequirePermission('stock.read')
  push(@Ctx() ctx: RequestContext, @Body(new ZodPipe(PushRequest)) body: PushRequest) {
    return this.inventory.push(ctx, body).then((results) => ({ results }));
  }

  /** Verpasste Bewegungen einer Filiale seit Cursor abholen. */
  @Get('sync/pull')
  @RequirePermission('stock.read')
  pull(@Ctx() ctx: RequestContext, @Query(new ZodPipe(PullQuery)) q: PullQuery) {
    return this.inventory.pull(ctx, q);
  }

  /** Dashboard-Warnungen (Mindestbestand, MHD) einer Filiale. */
  @Get('stores/:storeId/stock-alerts')
  @RequirePermission('report.stock')
  alerts(@Ctx() ctx: RequestContext, @Param('storeId', ParseUUIDPipe) storeId: string) {
    assertStoreAccess(ctx, storeId);
    return this.inventory.storeOverview(ctx, storeId);
  }

  @Get('stores/:storeId/stock')
  @RequirePermission('stock.read')
  stock(
    @Ctx() ctx: RequestContext,
    @Param('storeId', ParseUUIDPipe) storeId: string,
    @Query(new ZodPipe(StockQuery)) q: StockQuery,
  ) {
    assertStoreAccess(ctx, storeId);
    return this.inventory.stockList(ctx, storeId, q);
  }
}
