import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ApiClient, ApiError, SignedOutError, type Session, type SessionStorage } from '../src/core/api-client.ts';
import { licenseAllowsWrite, licenseBannerColor, pickStore, tilesFor } from '../src/core/home.ts';

class MemoryStorage implements SessionStorage {
  session: Session | null;
  constructor(s: Session | null) { this.session = s; }
  async load() { return this.session; }
  async save(s: Session) { this.session = s; }
  async clear() { this.session = null; }
}

/** Minimaler Kundenserver: gültige Access-Tokens, rotierende Refresh-Tokens. */
function fakeServer() {
  const state = { valid: new Set(['A1']), refresh: new Set(['R1']), refreshCalls: 0, calls: [] as string[], n: 1 };
  const fetchFn = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = url.replace('https://laden.tn', '');
    state.calls.push(path);
    if (path === '/api/v1/auth/refresh') {
      state.refreshCalls++;
      await new Promise((r) => setTimeout(r, 5));
      const { refreshToken } = JSON.parse(String(init?.body)) as { refreshToken: string };
      if (!state.refresh.delete(refreshToken)) return new Response('{"message":"Sitzung abgelaufen"}', { status: 401 });
      state.n++;
      state.valid.add(`A${state.n}`); state.refresh.add(`R${state.n}`);
      return Response.json({ accessToken: `A${state.n}`, refreshToken: `R${state.n}`, expiresIn: 900 });
    }
    if (path === '/api/v1/auth/logout') return new Response(null, { status: 204 });
    const auth = (init?.headers as Record<string, string>).authorization?.replace('Bearer ', '');
    if (!auth || !state.valid.has(auth)) return new Response('{"message":"Token ungültig"}', { status: 401 });
    if (path === '/api/v1/fail') return Response.json({ message: 'Kreditlimit', code: 'CREDIT_LIMIT' }, { status: 409 });
    return Response.json({ ok: true, token: auth });
  };
  return { state, fetchFn };
}

const NOW = 1_800_000_000;

test('Kriterium 1: abgelaufenes Token -> genau ein Refresh, danach Wiederholung', async () => {
  const { state, fetchFn } = fakeServer();
  state.valid.clear();                                       // A1 serverseitig abgelaufen
  const storage = new MemoryStorage({ accessToken: 'A1', refreshToken: 'R1', expiresAt: NOW + 600 });
  const api = new ApiClient({ baseUrl: 'https://laden.tn', storage, fetchFn, clock: () => NOW });
  const r = await api.get<{ token: string }>('/api/v1/me');
  assert.equal(r.token, 'A2');
  assert.equal(state.refreshCalls, 1);
  assert.equal(storage.session?.refreshToken, 'R2', 'neues Refresh-Token gespeichert');
});

test('Kriterium 1: zweites 401 nach Refresh -> Abmelden', async () => {
  const { state, fetchFn } = fakeServer();
  state.valid.clear();
  let signedOut = 0;
  const storage = new MemoryStorage({ accessToken: 'A1', refreshToken: 'R1', expiresAt: NOW + 600 });
  const api = new ApiClient({ baseUrl: 'https://laden.tn', storage, clock: () => NOW, onSignedOut: () => signedOut++,
    fetchFn: async (url, init) => {
      if (!url.endsWith('/auth/refresh')) state.valid.clear();   // auch das neue Token wird abgelehnt
      return fetchFn(url, init);
    } });
  await assert.rejects(api.get('/api/v1/me'), SignedOutError);
  assert.equal(signedOut, 1);
  assert.equal(storage.session, null, 'Sitzung gelöscht');
});

test('Refresh-Token ungültig -> Abmelden ohne Endlosschleife', async () => {
  const { state, fetchFn } = fakeServer();
  state.valid.clear(); state.refresh.clear();
  let signedOut = 0;
  const storage = new MemoryStorage({ accessToken: 'A1', refreshToken: 'R1', expiresAt: NOW + 600 });
  const api = new ApiClient({ baseUrl: 'https://laden.tn', storage, fetchFn, clock: () => NOW, onSignedOut: () => signedOut++ });
  await assert.rejects(api.get('/api/v1/me'), SignedOutError);
  assert.equal(state.refreshCalls, 1);
  assert.equal(signedOut, 1);
});

test('Gleichzeitige Anfragen teilen sich eine Erneuerung (Rotation bleibt gültig)', async () => {
  const { state, fetchFn } = fakeServer();
  state.valid.clear();
  const storage = new MemoryStorage({ accessToken: 'A1', refreshToken: 'R1', expiresAt: NOW + 600 });
  const api = new ApiClient({ baseUrl: 'https://laden.tn', storage, fetchFn, clock: () => NOW });
  const results = await Promise.all([api.get<{ token: string }>('/a'), api.get<{ token: string }>('/b'), api.get<{ token: string }>('/c')]);
  assert.equal(state.refreshCalls, 1);
  assert.deepEqual(results.map((r) => r.token), ['A2', 'A2', 'A2']);
});

test('Erneuerung vor Ablauf (60 s Puffer) ohne vorheriges 401', async () => {
  const { state, fetchFn } = fakeServer();
  const storage = new MemoryStorage({ accessToken: 'A1', refreshToken: 'R1', expiresAt: NOW + 30 });
  const api = new ApiClient({ baseUrl: 'https://laden.tn', storage, fetchFn, clock: () => NOW });
  const r = await api.get<{ token: string }>('/api/v1/me');
  assert.equal(r.token, 'A2');
  assert.equal(state.calls.filter((c) => c === '/api/v1/me').length, 1, 'kein vergeblicher Versuch mit altem Token');
});

test('Fachlicher Fehler -> ApiError mit Status und Body (z. B. Kreditlimit)', async () => {
  const { fetchFn } = fakeServer();
  const api = new ApiClient({ baseUrl: 'https://laden.tn', fetchFn, clock: () => NOW,
    storage: new MemoryStorage({ accessToken: 'A1', refreshToken: 'R1', expiresAt: NOW + 600 }) });
  await assert.rejects(api.post('/api/v1/fail', {}), (e: ApiError) =>
    e instanceof ApiError && e.status === 409 && (e.body as { code: string }).code === 'CREDIT_LIMIT');
});

test('Ohne Sitzung: sofort SignedOutError, keine Anfrage', async () => {
  const { state, fetchFn } = fakeServer();
  const api = new ApiClient({ baseUrl: 'https://laden.tn', storage: new MemoryStorage(null), fetchFn });
  await assert.rejects(api.get('/x'), SignedOutError);
  assert.equal(state.calls.length, 0);
});

test('Abmelden: Server benachrichtigt, Sitzung lokal gelöscht', async () => {
  const { state, fetchFn } = fakeServer();
  let signedOut = 0;
  const storage = new MemoryStorage({ accessToken: 'A1', refreshToken: 'R1', expiresAt: NOW + 600 });
  await new ApiClient({ baseUrl: 'https://laden.tn', storage, fetchFn, onSignedOut: () => signedOut++ }).signOut();
  assert.ok(state.calls.includes('/api/v1/auth/logout'));
  assert.equal(storage.session, null);
  assert.equal(signedOut, 1);
});

// Rechte je Rolle wie in backend/src/auth/permissions.ts (Integrationstest T-109 prüft die Serverseite)
const ROLE = {
  owner: ['tenant.settings', 'user.manage', 'user.manage.all', 'report.finance', 'report.stock', 'product.write', 'price.update',
    'stock.receive', 'stock.adjust', 'stock.read', 'purchase.order', 'document.scan', 'sale.create', 'sale.void',
    'discount.approve', 'export.accounting', 'device.manage', 'customer.manage', 'sales.order', 'invoice.issue', 'payment.record'],
  manager: ['user.manage', 'report.finance', 'report.stock', 'product.write', 'price.update', 'stock.receive', 'stock.adjust',
    'stock.read', 'purchase.order', 'document.scan', 'sale.create', 'sale.void', 'discount.approve', 'export.accounting',
    'device.manage', 'customer.manage', 'sales.order', 'invoice.issue', 'payment.record'],
  stock_clerk: ['product.write', 'stock.receive', 'stock.adjust', 'stock.read', 'document.scan', 'sales.order'],
  cashier: ['sale.create', 'stock.read'],
};

test('Kriterium 2: Kacheln je Rolle', () => {
  assert.deepEqual(tilesFor(ROLE.owner), ['orders', 'products', 'customers', 'warehouse', 'payments', 'pos', 'users', 'devices']);
  assert.deepEqual(tilesFor(ROLE.manager), ['orders', 'products', 'customers', 'warehouse', 'payments', 'pos', 'users', 'devices']);
  assert.deepEqual(tilesFor(ROLE.stock_clerk), ['orders', 'products', 'customers', 'warehouse']);
  const cashier = tilesFor(ROLE.cashier);
  assert.deepEqual(cashier, ['products', 'pos']);
  assert.ok(!cashier.includes('orders') && !cashier.includes('users'), 'Kassierer sieht weder Aufträge noch Benutzer');
});

test('Lizenz: Schreiben nur aktiv/Warnung; Banner-Farben; Filialauswahl', () => {
  assert.equal(licenseAllowsWrite('active'), true);
  assert.equal(licenseAllowsWrite('warning'), true);
  assert.equal(licenseAllowsWrite('read_only'), false);
  assert.equal(licenseAllowsWrite('unlicensed'), false);
  assert.equal(licenseBannerColor('active'), null);
  assert.ok(licenseBannerColor('read_only'));
  const stores = [{ id: 's1' }, { id: 's2' }];
  assert.equal(pickStore(stores, 's2'), 's2');
  assert.equal(pickStore(stores, 'weg'), 's1', 'entzogene Filiale wird nicht übernommen');
  assert.equal(pickStore([], null), null);
});
