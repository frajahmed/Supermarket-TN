/**
 * HTTP-Schicht des Lizenzservers (node:http, keine Frameworks).
 *
 * Öffentlich (Geräte / Kundenserver):
 *   POST /v1/activation-requests          neues Gerät meldet sich an
 *   GET  /v1/activation-requests/:id      Gerät fragt Status ab, erhält Zertifikat
 *   POST /v1/license/check                Kundenserver holt Lizenzbestätigung (Bearer = Installations-Secret)
 *   GET  /v1/public-key                   öffentlicher Signaturschlüssel (für die Installation)
 * Verwaltung (du):
 *   GET  /admin                           Verwaltungsportal (HTML)
 *   POST /admin/api/login | /logout
 *   GET  /admin/api/licensees             POST /admin/api/licensees   PATCH /admin/api/licensees/:id
 *   GET  /admin/api/devices?status=       POST /admin/api/devices/:id/approve | reject | revoke
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ADMIN_HTML } from './admin-page.ts';
import { LicenseService, ServiceError } from './service.ts';

const MAX_BODY = 64 * 1024;


type Handler = (req: IncomingMessage, params: string[], body: any) => Promise<unknown> | unknown;

/** Einfache Begrenzung je IP (gegen massenhaftes Anfragen/Raten). */
class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }
  allow(key: string): boolean {
    const now = Date.now();
    const list = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    list.push(now);
    this.hits.set(key, list);
    return list.length <= this.limit;
  }
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new ServiceError(413, 'Anfrage zu groß'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ServiceError(400, 'Ungültiges JSON'));
      }
    });
    req.on('error', reject);
  });
}

const bearer = (req: IncomingMessage) => {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7) : undefined;
};

const clientIp = (req: IncomingMessage, trustProxy: boolean) =>
  (trustProxy ? String(req.headers['x-forwarded-for'] ?? '').split(',')[0].trim() : '') ||
  req.socket.remoteAddress || 'unknown';

function send(res: ServerResponse, status: number, data: unknown, type = 'application/json; charset=utf-8') {
  const body = type.startsWith('application/json') ? JSON.stringify(data) : String(data);
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...(type.startsWith('text/html')
      ? { 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline' 'self'; style-src 'unsafe-inline' 'self'; frame-ancestors 'none'" }
      : {}),
  });
  res.end(body);
}

export function createLicenseServer(svc: LicenseService, publicKeyPem: string, opts: { trustProxy?: boolean } = {}): Server {
  const activationLimiter = new RateLimiter(10, 60_000);
  const loginLimiter = new RateLimiter(10, 15 * 60_000);

  const admin = (h: (adminId: string, ...a: Parameters<Handler>) => unknown): Handler =>
    (req, params, body) => h(svc.adminFromSession(bearer(req)), req, params, body);

  const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/v1\/public-key$/, () => ({ publicKey: publicKeyPem })],
    ['POST', /^\/v1\/activation-requests$/, (req, _p, b) => {
      if (!activationLimiter.allow(clientIp(req, !!opts.trustProxy))) throw new ServiceError(429, 'Zu viele Anfragen');
      return svc.requestActivation(b, clientIp(req, !!opts.trustProxy));
    }],
    ['GET', /^\/v1\/activation-requests\/([0-9a-f-]{36})$/, (_r, [id]) => svc.activationStatus(id)],
    ['POST', /^\/v1\/license\/check$/, (req, _p, b) =>
      ({ license: svc.checkLicense(String(b.installationId ?? ''), bearer(req) ?? '') })],

    ['POST', /^\/admin\/api\/login$/, async (req, _p, b) => {
      if (!loginLimiter.allow(clientIp(req, !!opts.trustProxy))) throw new ServiceError(429, 'Zu viele Anmeldeversuche');
      return svc.adminLogin(String(b.email ?? ''), String(b.password ?? ''));
    }],
    ['POST', /^\/admin\/api\/logout$/, admin((_id, req) => { svc.adminLogout(bearer(req)!); return { ok: true }; })],
    ['GET', /^\/admin\/api\/licensees$/, admin(() => svc.listLicensees())],
    ['POST', /^\/admin\/api\/licensees$/, admin((id, _r, _p, b) => svc.createLicensee(id, b))],
    ['PATCH', /^\/admin\/api\/licensees\/([0-9a-f-]{36})$/, admin((id, _r, [lid], b) => { svc.updateLicensee(id, lid, b); return { ok: true }; })],
    ['GET', /^\/admin\/api\/devices$/, admin((_id, req) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams;
      return svc.listDevices(q.get('licensee') ?? undefined, q.get('status') ?? undefined);
    })],
    ['POST', /^\/admin\/api\/devices\/([0-9a-f-]{36})\/approve$/, admin((id, _r, [d]) => { svc.approveDevice(id, d); return { ok: true }; })],
    ['POST', /^\/admin\/api\/devices\/([0-9a-f-]{36})\/reject$/,  admin((id, _r, [d]) => { svc.rejectDevice(id, d); return { ok: true }; })],
    ['POST', /^\/admin\/api\/devices\/([0-9a-f-]{36})\/revoke$/,  admin((id, _r, [d]) => { svc.revokeDevice(id, d); return { ok: true }; })],
  ];

  return createServer(async (req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    try {
      if (req.method === 'GET' && (path === '/admin' || path === '/admin/')) return send(res, 200, ADMIN_HTML, 'text/html; charset=utf-8');
      if (req.method === 'GET' && path === '/health') return send(res, 200, { status: 'ok' });
      for (const [method, re, handler] of routes) {
        const m = req.method === method ? re.exec(path) : null;
        if (!m) continue;
        const body = method === 'GET' ? {} : await readBody(req);
        return send(res, 200, await handler(req, m.slice(1), body));
      }
      send(res, 404, { error: 'Nicht gefunden' });
    } catch (err) {
      if (err instanceof ServiceError) return send(res, err.status, { error: err.message });
      console.error(err);
      send(res, 500, { error: 'Interner Fehler' });
    }
  });
}
