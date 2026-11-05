export interface Session {
  accessToken: string;
  refreshToken: string;
  /** Ablauf des Access-Tokens, Unix-Sekunden */
  expiresAt: number;
}

export interface SessionStorage {
  load(): Promise<Session | null>;
  save(session: Session): Promise<void>;
  clear(): Promise<void>;
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export class SignedOutError extends Error {
  constructor() {
    super('Sitzung beendet – bitte neu anmelden');
  }
}

export function sessionFromTokenResponse(r: { accessToken: string; refreshToken: string; expiresIn: number }, now: number): Session {
  return { accessToken: r.accessToken, refreshToken: r.refreshToken, expiresAt: now + r.expiresIn };
}

const REFRESH_MARGIN_SECONDS = 60;

export class ApiClient {
  private readonly baseUrl: string;
  private readonly storage: SessionStorage;
  private readonly fetchFn: FetchFn;
  private readonly clock: () => number;
  private readonly onSignedOut: () => void;
  private refreshing: Promise<Session> | null = null;

  constructor(options: {
    baseUrl: string; storage: SessionStorage; fetchFn: FetchFn;
    clock?: () => number; onSignedOut?: () => void;
  }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/u, '');
    this.storage = options.storage;
    this.fetchFn = options.fetchFn;
    this.clock = options.clock ?? (() => Math.floor(Date.now() / 1000));
    this.onSignedOut = options.onSignedOut ?? (() => undefined);
  }

  async get<T>(path: string): Promise<T> {
    return this.request<T>(path, { method: 'GET' });
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) });
  }

  async patch<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
  }

  async text(path: string): Promise<string> {
    return this.request<string>(path, { method: 'GET' }, 'text');
  }

  async signOut(): Promise<void> {
    const session = await this.storage.load();
    if (session) {
      await this.fetchFn(this.url('/api/v1/auth/logout'), {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken }),
      }).catch(() => undefined);
    }
    await this.storage.clear();
    this.onSignedOut();
  }

  private url(path: string) {
    return `${this.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  }

  private async request<T>(path: string, init: RequestInit, as: 'json' | 'text' = 'json'): Promise<T> {
    let session = await this.storage.load();
    if (!session) throw new SignedOutError();
    if (session.expiresAt - this.clock() <= REFRESH_MARGIN_SECONDS) session = await this.refresh(session);

    let response = await this.send(path, init, session);
    if (response.status === 401) {
      session = await this.refresh(session);
      response = await this.send(path, init, session);
      if (response.status === 401) {
        await this.forceSignOut();
        throw new SignedOutError();
      }
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      const message = typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : typeof (body as { message?: { message?: unknown } }).message === 'object'
          ? String((body as { message: { message?: unknown } }).message.message ?? `HTTP ${response.status}`)
          : `HTTP ${response.status}`;
      throw new ApiError(response.status, message, body);
    }
    if (as === 'text') return (await response.text()) as T;
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private send(path: string, init: RequestInit, session: Session) {
    return this.fetchFn(this.url(path), {
      ...init,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}), authorization: `Bearer ${session.accessToken}` },
    });
  }

  // Refresh-Tokens rotieren: ein zweiter paralleler Refresh gälte dem Server als Diebstahl und beendete die Sitzung.
  private refresh(current: Session): Promise<Session> {
    if (!this.refreshing) {
      this.refreshing = (async () => {
        try {
          const response = await this.fetchFn(this.url('/api/v1/auth/refresh'), {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ refreshToken: current.refreshToken }),
          });
          if (!response.ok) {
            await this.forceSignOut();
            throw new SignedOutError();
          }
          const next = sessionFromTokenResponse(await response.json() as {
            accessToken: string; refreshToken: string; expiresIn: number }, this.clock());
          await this.storage.save(next);
          return next;
        } finally {
          this.refreshing = null;
        }
      })();
    }
    return this.refreshing;
  }

  private async forceSignOut() {
    await this.storage.clear();
    this.onSignedOut();
  }
}
