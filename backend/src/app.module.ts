import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthGuard, Public } from './auth/auth.guard';
import { DbService } from './db/db.service';
import { InventoryController } from './inventory/inventory.controller';
import { InventoryService } from './inventory/inventory.service';
import { OutboxWorker } from './realtime/outbox.worker';
import { StockGateway } from './realtime/stock.gateway';

@Controller('health')
class HealthController {
  @Get() @Public()
  ok() {
    return { status: 'ok' };
  }
}

@Module({
  controllers: [HealthController, InventoryController],
  providers: [
    DbService,
    AuthGuard,
    { provide: APP_GUARD, useExisting: AuthGuard },   // jeder Endpoint ist standardmäßig geschützt
    InventoryService,
    StockGateway,
    OutboxWorker,
  ],
})
export class AppModule {}
