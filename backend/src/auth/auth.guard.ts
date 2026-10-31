import {
  CanActivate, ExecutionContext, ForbiddenException, Injectable,
  SetMetadata, UnauthorizedException, createParamDecorator,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { importSPKI, jwtVerify, KeyLike } from 'jose';
import { DbService } from '../db/db.service';
import { hasPermission, Permission } from './permissions';
import { AccessTokenClaims, RequestContext, UserRole } from './request-context';

const PERMISSION_KEY = 'required_permission';
const PUBLIC_KEY = 'is_public';

/** Markiert einen Endpoint mit dem nötigen Recht: @RequirePermission('stock.receive') */
export const RequirePermission = (p: Permission) => SetMetadata(PERMISSION_KEY, p);
/** Endpoint ohne Login (nur Login/Health). */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/** Liefert den geprüften Kontext im Controller: handler(@Ctx() ctx: RequestContext) */
export const Ctx = createParamDecorator(
  (_: unknown, ec: ExecutionContext): RequestContext => ec.switchToHttp().getRequest().ctx,
);

const ROLES: readonly UserRole[] = ['owner', 'manager', 'stock_clerk', 'cashier'];

/**
 * Globaler Guard, Reihenfolge:
 * 1. Bearer-Token prüfen (EdDSA-Signatur, Ablauf, Aussteller).
 * 2. Filialzuordnung frisch aus der DB laden – entzogene Rechte wirken sofort,
 *    nicht erst nach Ablauf des Tokens.
 * 3. Recht des Endpoints gegen die Rolle prüfen.
 * Der Kontext wird an request.ctx gehängt und vom DbService als RLS-Kontext gesetzt.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private keyPromise?: Promise<KeyLike>;

  constructor(private readonly reflector: Reflector, private readonly db: DbService) {}

  private key(): Promise<KeyLike> {
    const pem = process.env.JWT_PUBLIC_KEY;
    if (!pem) throw new Error('JWT_PUBLIC_KEY fehlt');
    return (this.keyPromise ??= importSPKI(pem, 'EdDSA'));
  }

  async canActivate(ec: ExecutionContext): Promise<boolean> {
    const targets = [ec.getHandler(), ec.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, targets)) return true;

    const req = ec.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    if (!header?.startsWith('Bearer ')) throw new UnauthorizedException();

    const claims = await this.verify(header.slice(7));
    req.ctx = await this.buildContext(claims);

    const required = this.reflector.getAllAndOverride<Permission | undefined>(PERMISSION_KEY, targets);
    if (required && !hasPermission(req.ctx.role, required)) {
      throw new ForbiddenException(`Recht fehlt: ${required}`);
    }
    return true;
  }

  async verify(token: string): Promise<AccessTokenClaims> {
    try {
      const { payload } = await jwtVerify(token, await this.key(), {
        algorithms: ['EdDSA'],
        issuer: process.env.JWT_ISSUER ?? 'warenwirtschaft',
      });
      const role = payload.role as UserRole;
      if (typeof payload.sub !== 'string' || typeof payload.tid !== 'string' || !ROLES.includes(role)) {
        throw new Error('Ungültige Claims');
      }
      return { sub: payload.sub, tid: payload.tid, role, did: payload.did as string | undefined };
    } catch {
      throw new UnauthorizedException('Token ungültig oder abgelaufen');
    }
  }

  async buildContext(claims: AccessTokenClaims): Promise<RequestContext> {
    const storeIds = await this.db.system(async (c) => {
      const res = await c.query<{ ids: string[] }>(
        'SELECT auth.user_store_ids($1, $2) AS ids',
        [claims.tid, claims.sub],
      );
      return res.rows[0]?.ids ?? [];
    });
    return {
      tenantId: claims.tid,
      userId: claims.sub,
      role: claims.role,
      storeIds,
      deviceId: claims.did,
    };
  }
}
