import { Body, Controller, Get, Param, ParseUUIDPipe, Patch, Post } from '@nestjs/common';
import { Ctx, RequirePermission } from '../auth/auth.guard';
import { RequestContext } from '../auth/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { UserCreate, UserPatch } from './users.dto';
import { UsersService } from './users.service';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @RequirePermission('user.manage')
  list(@Ctx() ctx: RequestContext) {
    return this.users.list(ctx);
  }

  @Post()
  @RequirePermission('user.manage')
  create(@Ctx() ctx: RequestContext, @Body(new ZodPipe(UserCreate)) body: UserCreate) {
    return this.users.create(ctx, body);
  }

  @Patch(':id')
  @RequirePermission('user.manage')
  update(
    @Ctx() ctx: RequestContext,
    @Param('id', ParseUUIDPipe) id: string,
    @Body(new ZodPipe(UserPatch)) body: UserPatch,
  ) {
    return this.users.update(ctx, id, body);
  }
}
