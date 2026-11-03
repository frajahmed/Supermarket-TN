import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { Ctx } from '../auth/auth.guard';
import { RequestContext } from '../auth/request-context';
import { ZodPipe } from '../common/zod.pipe';
import { TotpConfirm } from '../users/users.dto';
import { MeService } from './me.service';

/** Endpunkte für den angemeldeten Nutzer selbst. */
@Controller('me')
export class MeController {
  constructor(private readonly me: MeService) {}

  /** Startet die 2FA-Einrichtung; Antwort enthält das Geheimnis genau einmal. */
  @Post('2fa/setup') @HttpCode(200)
  setup(@Ctx() ctx: RequestContext) {
    return this.me.setupTotp(ctx);
  }

  /** Aktiviert 2FA mit einem gültigen Code aus der Authenticator-App. */
  @Post('2fa/confirm') @HttpCode(200)
  confirm(@Ctx() ctx: RequestContext, @Body(new ZodPipe(TotpConfirm)) body: TotpConfirm) {
    return this.me.confirmTotp(ctx, body.code);
  }
}
