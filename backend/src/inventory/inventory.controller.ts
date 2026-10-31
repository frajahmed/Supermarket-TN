import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Ctx, RequirePermission } from '../auth/auth.guard';
import { RequestContext } from '../auth/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { PullQuery, PushRequest } from './inventory.dto';
import { InventoryService } from './inventory.service';

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
    // Klare 403 statt leerer Liste; RLS würde ohnehin nichts liefern
    if (ctx.role !== 'owner' && !ctx.storeIds.includes(storeId)) throw new ForbiddenException();
    return this.inventory.storeOverview(ctx, storeId);
  }
}
