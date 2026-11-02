import { Body, Controller, Get, HttpCode, HttpException, Post } from '@nestjs/common';
import { z } from 'zod';
import { AuthError, type AuthFlow } from '../core/auth-flow.ts';
import { ZodPipe } from '../common/zod.pipe';
import { LicensingService } from '../licensing/licensing.service';
import { AuthFlowProvider } from './auth.module-providers';
import { Public } from './auth.guard';

const DeviceProof = z.object({
  certificate: z.string().min(20).max(4000),
  challenge: z.string().min(16).max(100),
  signature: z.string().min(40).max(200),
});

const LoginBody = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200).optional(),
  pin: z.string().regex(/^\d{4,8}$/).optional(),
  totp: z.string().regex(/^\d{6}$/).optional(),
  device: DeviceProof,
}).refine((b) => (b.password === undefined) !== (b.pin === undefined), 'Entweder Passwort oder PIN angeben');

const RefreshBody = z.object({ refreshToken: z.string().min(20).max(200) });

/** AuthError -> HTTP-Status, ohne interne Details nach außen. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof AuthError) throw new HttpException({ message: e.message }, e.status);
    throw e;
  }
}

@Controller()
export class AuthController {
  constructor(private readonly auth: AuthFlowProvider, private readonly licensing: LicensingService) {}

  private get flow(): AuthFlow {
    return this.auth.flow;
  }

  /** Schritt 1: Gerät holt eine Einmal-Challenge (60 s gültig). */
  @Public() @Post('auth/challenge') @HttpCode(200)
  challenge() {
    return { challenge: this.auth.challenges.issue(), expiresIn: 60 };
  }

  /** Schritt 2: Gerät signiert die Challenge und sendet sie mit Zertifikat und Zugangsdaten. */
  @Public() @Post('auth/login') @HttpCode(200)
  login(@Body(new ZodPipe(LoginBody)) body: z.infer<typeof LoginBody>) {
    return run(() => this.flow.login(body));
  }

  @Public() @Post('auth/refresh') @HttpCode(200)
  refresh(@Body(new ZodPipe(RefreshBody)) body: z.infer<typeof RefreshBody>) {
    return run(() => this.flow.refresh(body.refreshToken));
  }

  @Public() @Post('auth/logout') @HttpCode(204)
  async logout(@Body(new ZodPipe(RefreshBody)) body: z.infer<typeof RefreshBody>) {
    await run(() => this.flow.logout(body.refreshToken));
  }

  /** Für das Banner in der App: aktiv / Warnung / Nur-Lesen und warum. */
  @Get('license/status')
  status() {
    return this.licensing.gate.status();
  }
}
