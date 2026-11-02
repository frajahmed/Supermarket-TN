import { Controller, Get, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AuthController } from './auth/auth.controller';
import { AuthGuard, Public } from './auth/auth.guard';
import { AuthFlowProvider } from './auth/auth.module-providers';
import { PgAuthRepo } from './auth/pg-auth.repo';
import { DbService } from './db/db.service';
import { InventoryController } from './inventory/inventory.controller';
import { InventoryService } from './inventory/inventory.service';
import { LicensingService } from './licensing/licensing.service';
import { OutboxWorker } from './realtime/outbox.worker';
import { StockGateway } from './realtime/stock.gateway';
import { ProductsController } from './products/products.controller';
import { ProductsService } from './products/products.service';
import { UsersController } from './users/users.controller';
import { UsersService } from './users/users.service';
import { SetupController } from './setup/setup.controller';

@Controller('health')
class HealthController {
  @Get() @Public()
  ok() {
    return { status: 'ok' };
  }
}

@Module({
  controllers: [HealthController, AuthController, InventoryController, ProductsController, UsersController, SetupController],
  providers: [
    DbService,
    LicensingService,
    PgAuthRepo,
    AuthFlowProvider,
    AuthGuard,
    { provide: APP_GUARD, useExisting: AuthGuard },   // jeder Endpoint ist standardmäßig geschützt
    InventoryService,
    StockGateway,
    OutboxWorker,
    ProductsService,
    UsersService,
  ],
})
export class AppModule {}
