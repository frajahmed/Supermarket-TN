import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Ctx, RequirePermission } from '../auth/auth.guard';
import { RequestContext } from '../auth/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { DevicePatch } from './devices.dto';
import { DevicesService } from './devices.service';

// Lokale Sperre beim Kunden; die Freischaltung beim Lizenzserver bleibt davon unberührt.
@Controller('devices')
export class DevicesController {
  constructor(private readonly devices: DevicesService) {}

  @Get()
  @RequirePermission('device.manage')
  list(@Ctx() ctx: RequestContext) {
    return this.devices.list(ctx);
  }

  @Patch(':id')
  @RequirePermission('device.manage')
  update(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string, @Body(new ZodPipe(DevicePatch)) body: DevicePatch) {
    return this.devices.update(ctx, id, body);
  }

  @Post(':id/revoke') @HttpCode(200)
  @RequirePermission('device.manage')
  revoke(@Ctx() ctx: RequestContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.devices.revoke(ctx, id);
  }
}
