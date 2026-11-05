import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable,
  SetMetadata, UnauthorizedException, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { verifyJwt, JwtError } from '../core/jwt.ts';
import { DbService } from '../db/db.service';
import { LicensingService } from '../licensing/licensing.service';
import { AuthFlowProvider } from './auth.module-providers';
import { hasPermission, Permission } from './permissions';
import { AccessTokenClaims, RequestContext } from './request-context';

const PERMISSION_KEY = 'required_permission';
const PUBLIC_KEY = 'is_public';

/** Markiert einen Endpoint mit dem nötigen Recht: @RequirePermission('stock.receive') */
export const RequirePermission = (p: Permission) => SetMetadata(PERMISSION_KEY, p);
/** Endpoint ohne Login (Login selbst, Health). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Liefert den geprüften Kontext im Controller: handler(@Ctx() ctx: RequestContext) */
export const Ctx = createParamDecorator(
  (_: unknown, ec: ExecutionContext): RequestContext => ec.switchToHttp().getRequest().ctx,
);

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Globaler Guard, Reihenfolge:
 * 1. Access-Token prüfen (Ed25519-Signatur dieses Kundenservers, Ablauf).
 * 2. Gerät gesperrt? (Lizenzserver-Sperrliste) -> sofort 401, nicht erst nach Token-Ablauf.
 * 3. Lizenz im Nur-Lesen-Modus? -> schreibende Anfragen 403.
 * 4. Filialzuordnung frisch aus der DB laden (entzogene Rechte wirken sofort).
 * 5. Recht des Endpoints gegen die Rolle prüfen.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly db: DbService,
    private readonly licensing: LicensingService,
    private readonly auth: AuthFlowProvider,
  ) {}

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const targets = [ec.getHandler(), ec.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = ec.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();

    const claims = this.verify(header.slice(7));
    if (!READ_METHODS.has(req.method) && !this.licensing.gate.allowsWrite()) {
      throw new ForbiddenException({ message: this.licensing.gate.status().reason, licenseMode: 'read_only' });
    }
    req.ctx = await this.buildContext(claims);

    const required = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, targets);
    if (required && !hasPermission(req.ctx.role, required)) {
      throw new ForbiddenException(`Recht fehlt: ${required}`);
    }
    return true;
  }

  /** Auch vom WebSocket-Gateway genutzt. */
  verify(token: string): AccessTokenClaims {
    let c;
    try {
      c = verifyJwt(token, this.auth.jwt.publicKey);
    } catch (e) {
      throw new UnauthorizedException(e instanceof JwtError ? 'Token ungültig oder abgelaufen' : 'Token ungültig');
    }
    if (this.licensing.gate.isDeviceRevoked(c.did)) throw new UnauthorizedException('Gerät wurde gesperrt');
    return { sub: c.sub, tid: c.tid, role: c.role, did: c.did };
  }

  async buildContext(claims: AccessTokenClaims): Promise<RequestContext> {
    const { storeIds, revoked } = await this.db.system(async (c) => {
      const res = await c.query<{ ids: string[]; revoked: boolean }>(
        'SELECT auth.user_store_ids($1, $2) AS ids, auth.device_is_revoked($1, $3) AS revoked', [claims.tid, claims.sub, claims.did]);
      return { storeIds: res.rows[0]?.ids ?? [], revoked: res.rows[0]?.revoked ?? false };
    });
    // Lokale Sperre durch den Inhaber wirkt sofort, nicht erst nach Ablauf des Access-Tokens.
    if (revoked) throw new UnauthorizedException('Gerät wurde gesperrt');
    return { tenantId: claims.tid, userId: claims.sub, role: claims.role, storeIds, deviceId: claims.did };
  }
}
