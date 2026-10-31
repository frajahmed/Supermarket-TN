/**
 * Gesamttest Lizenzserver <-> Kundenserver (ohne NestJS, ohne Datenbank-Treiber):
 *   - echter Lizenzserver per HTTP
 *   - LicenseGate + AuthFlow des Kundenservers mit In-Memory-Repo
 *     (die SQL-Seite derselben Schritte testet db/tests/004_auth_test.sql)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, type KeyObject } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import {
  generateSigningKeys, hashSecret, loadPrivateKey, loadPublicKey, publicKeyToB64, signChallenge,
  type DeviceCertificate,
} from '../../shared/license-core.ts';
import { openDatabase } from '../../license-server/src/db.ts';
import { createLicenseServer } from '../../license-server/src/http.ts';
import { LicenseService } from '../../license-server/src/service.ts';
import { AuthError, AuthFlow, ChallengeStore, type AuthRepo, type Role } from '../src/core/auth-flow.ts';
import { JwtError, signJwt, verifyJwt } from '../src/core/jwt.ts';
import { LicenseGate, syncLicense } from '../src/core/license-gate.ts';

// ---------- Lizenzserver ----------
const licKeys = generateSigningKeys();
const licPub = loadPublicKey(licKeys.publicPem);
let server: Server;
let licUrl = '';
let licSvc: LicenseService;
let adminId = '';
let inst = { installationId: '', installationSecret: '' };

// ---------- Kundenserver ----------
let now = Math.floor(Date.now() / 1000);
const clock = () => now;
const jwtKeys = generateKeyPairSync('ed25519');
let savedLicense: string | null = null;
let gate: LicenseGate;
let flow: AuthFlow;
const challenges = new ChallengeStore(60, clock);
const TENANT = randomUUID();

/** In-Memory-Nachbildung der auth.*-Funktionen aus Migration 004. */
class MemoryRepo implements AuthRepo {
  users = new Map<string, { userId: string; tenantId: string; role: Role; passwordHash: string | null; pinHash: string | null;
    isActive: boolean; lockedUntil: number | null; failed: number }>();
  devices = new Map<string, { revoked: boolean }>();
  tokens = new Map<string, { userId: string; deviceId: string; family: string; used: boolean; revoked: boolean; exp: number }>();
  async loginCandidate(email: string) {
    const u = this.users.get(email.toLowerCase());
    return u ? { ...u } : null;
  }
  async recordLoginAttempt(userId: string, ok: boolean) {
    const u = [...this.users.values()].find((x) => x.userId === userId)!;
    if (ok) { u.failed = 0; u.lockedUntil = null; return; }
    u.failed++;
    if (u.failed >= 5) u.lockedUntil = clock() + 900 * 2 ** (u.failed - 5);
  }
  async registerDevice(_t: string, cert: DeviceCertificate) {
    const d = this.devices.get(cert.did) ?? { revoked: false };
    this.devices.set(cert.did, d);
    return !d.revoked;
  }
  async issueRefreshToken(t: { userId: string; deviceId: string; familyId: string; tokenHash: Buffer; ttlSeconds: number }) {
    this.tokens.set(t.tokenHash.toString('hex'), { userId: t.userId, deviceId: t.deviceId, family: t.familyId, used: false, revoked: false, exp: clock() + t.ttlSeconds });
  }
  async rotateRefreshToken(oldHash: Buffer, newHash: Buffer, ttl: number) {
    const t = this.tokens.get(oldHash.toString('hex'));
    if (!t) return { status: 'invalid' as const };
    if (t.used || t.revoked) {
      for (const x of this.tokens.values()) if (x.family === t.family) x.revoked = true;
      return { status: 'reuse' as const };
    }
    t.used = true;
    this.tokens.set(newHash.toString('hex'), { ...t, used: false, exp: clock() + ttl });
    const u = [...this.users.values()].find((x) => x.userId === t.userId)!;
    return { status: 'ok' as const, userId: u.userId, tenantId: u.tenantId, role: u.role, deviceId: t.deviceId };
  }
  async revokeRefreshFamily(h: Buffer) {
    const t = this.tokens.get(h.toString('hex'));
    if (t) for (const x of this.tokens.values()) if (x.family === t.family) x.revoked = true;
  }
}
const repo = new MemoryRepo();

/** Simuliertes Gerät (App auf Handy/Kasse) mit eigenem Schlüsselpaar. */
class Device {
  readonly privateKey: KeyObject;
  readonly publicKey: string;
  readonly name: string;
  readonly kind: 'pos' | 'phone' | 'scanner' | 'pc';
  certificate = '';
  requestId = '';
  constructor(name: string, kind: 'pos' | 'phone' | 'scanner' | 'pc') {
    this.name = name;
    this.kind = kind;
    const kp = generateKeyPairSync('ed25519');
    this.privateKey = kp.privateKey;
    this.publicKey = publicKeyToB64(kp.publicKey);
  }
  async requestActivation() {
    const res = await fetch(`${licUrl}/v1/activation-requests`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installationId: inst.installationId, name: this.name, kind: this.kind, publicKey: this.publicKey }),
    });
    const body = await res.json() as { requestId: string; activationCode: string };
    this.requestId = body.requestId;
    return body;
  }
  async poll() {
    const r = await (await fetch(`${licUrl}/v1/activation-requests/${this.requestId}`)).json() as { status: string; certificate?: string };
    if (r.certificate) this.certificate = r.certificate;
    return r.status;
  }
  proof() {
    const challenge = challenges.issue();
    return { certificate: this.certificate, challenge, signature: signChallenge(challenge, this.privateKey) };
  }
}

const sync = () => syncLicense(gate, { serverUrl: licUrl, ...inst });

before(async () => {
  licSvc = new LicenseService(openDatabase(':memory:'), loadPrivateKey(licKeys.privatePem));
  adminId = await licSvc.createAdmin('ahmed@example.tn', 'sehr-geheimes-passwort');
  server = createLicenseServer(licSvc, licKeys.publicPem).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  licUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  inst = licSvc.createLicensee(adminId, { name: 'Grossiste Sfax', maxDevices: 3, paidUntil: '2099-12-31' });

  gate = new LicenseGate(licPub, inst.installationId,
    { load: async () => savedLicense, save: async (t) => { savedLicense = t; } }, clock);
  await gate.init();
  flow = new AuthFlow({ repo, gate, challenges, licensePublicKey: licPub, installationId: inst.installationId,
    jwtKey: jwtKeys.privateKey, clock });

  repo.users.set('chef@g.tn', { userId: randomUUID(), tenantId: TENANT, role: 'owner',
    passwordHash: await hashSecret('Chef-Passwort-2026'), pinHash: null, isActive: true, lockedUntil: null, failed: 0 });
  repo.users.set('caisse@g.tn', { userId: randomUUID(), tenantId: TENANT, role: 'cashier',
    passwordHash: null, pinHash: await hashSecret('4711'), isActive: true, lockedUntil: null, failed: 0 });
});

after(() => server.close());

const kasse = new Device('Kasse 1', 'pos');
const handy = new Device('Handy Chef', 'phone');

test('Ohne Lizenzbestätigung ist keine Anmeldung möglich', async () => {
  assert.equal(gate.status().mode, 'unlicensed');
  await assert.rejects(flow.login({ email: 'chef@g.tn', password: 'Chef-Passwort-2026', device: kasse.proof() }),
    (e: AuthError) => e.status === 403);
});

test('Lizenzabgleich holt signierte Bestätigung und speichert sie', async () => {
  const r = await sync();
  assert.deepEqual(r, { ok: true, mode: 'active' });
  assert.ok(savedLicense);
  assert.equal(gate.status().mode, 'active');
});

test('Nicht freigeschaltetes Gerät kommt nicht rein', async () => {
  await kasse.requestActivation();
  assert.equal(await kasse.poll(), 'pending');
  await assert.rejects(flow.login({ email: 'chef@g.tn', password: 'Chef-Passwort-2026', device: kasse.proof() }),
    (e: AuthError) => e.status === 401 && /nicht freigeschaltet/.test(e.message));
});

test('Nach Freischaltung durch Ahmed: Anmeldung mit Passwort klappt', async () => {
  licSvc.approveDevice(adminId, kasse.requestId);
  assert.equal(await kasse.poll(), 'approved');
  const r = await flow.login({ email: 'Chef@g.tn', password: 'Chef-Passwort-2026', device: kasse.proof() });
  const claims = verifyJwt(r.accessToken, jwtKeys.publicKey, now);
  assert.equal(claims.role, 'owner');
  assert.equal(claims.did, kasse.requestId);
  assert.equal(r.device.name, 'Kasse 1');
});

test('Zertifikat allein reicht nicht: ohne privaten Geräteschlüssel keine Anmeldung', async () => {
  const thief = new Device('Kopie', 'pos');
  const challenge = challenges.issue();
  const stolen = { certificate: kasse.certificate, challenge, signature: signChallenge(challenge, thief.privateKey) };
  await assert.rejects(flow.login({ email: 'chef@g.tn', password: 'Chef-Passwort-2026', device: stolen }),
    (e: AuthError) => /Gerätesignatur ungültig/.test(e.message));
});

test('Challenge ist nur einmal gültig (kein Wiederabspielen)', async () => {
  const proof = kasse.proof();
  await flow.login({ email: 'chef@g.tn', password: 'Chef-Passwort-2026', device: proof });
  await assert.rejects(flow.login({ email: 'chef@g.tn', password: 'Chef-Passwort-2026', device: proof }),
    (e: AuthError) => /Challenge/.test(e.message));
});

test('Kassen-PIN: an der Kasse ja, am Handy nein, für Inhaber nie', async () => {
  const ok = await flow.login({ email: 'caisse@g.tn', pin: '4711', device: kasse.proof() });
  assert.equal(ok.user.role, 'cashier');

  await handy.requestActivation();
  licSvc.approveDevice(adminId, handy.requestId);
  await handy.poll();
  await assert.rejects(flow.login({ email: 'caisse@g.tn', pin: '4711', device: handy.proof() }),
    (e: AuthError) => /nur an Kasse/.test(e.message));
  await assert.rejects(flow.login({ email: 'chef@g.tn', pin: '0000', device: kasse.proof() }),
    (e: AuthError) => /PIN-Anmeldung nur für Kasse und Lager/.test(e.message));
});

test('Falsches Passwort: generische Meldung, nach 5 Versuchen gesperrt', async () => {
  for (let i = 0; i < 5; i++) {
    await assert.rejects(flow.login({ email: 'chef@g.tn', password: 'falsch', device: handy.proof() }),
      (e: AuthError) => e.status === 401 && e.message === 'Anmeldung fehlgeschlagen');
  }
  await assert.rejects(flow.login({ email: 'chef@g.tn', password: 'Chef-Passwort-2026', device: handy.proof() }),
    (e: AuthError) => e.status === 423);
  now += 16 * 60;   // 16 Minuten später
  await flow.login({ email: 'chef@g.tn', password: 'Chef-Passwort-2026', device: handy.proof() });
});

test('Unbekannte E-Mail verrät nichts', async () => {
  await assert.rejects(flow.login({ email: 'gibtsnicht@g.tn', password: 'x', device: handy.proof() }),
    (e: AuthError) => e.status === 401 && e.message === 'Anmeldung fehlgeschlagen');
});

test('Refresh-Rotation; gestohlenes altes Token beendet die Sitzung', async () => {
  const login = await flow.login({ email: 'chef@g.tn', password: 'Chef-Passwort-2026', device: handy.proof() });
  const r1 = await flow.refresh(login.refreshToken);
  assert.notEqual(r1.refreshToken, login.refreshToken);
  await assert.rejects(flow.refresh(login.refreshToken), (e: AuthError) => /Sicherheitsgründen/.test(e.message));
  await assert.rejects(flow.refresh(r1.refreshToken), (e: AuthError) => e.status === 401, 'ganze Kette gesperrt');
});

test('Ahmed sperrt ein Gerät -> nach dem nächsten Abgleich kein Login und kein Refresh mehr', async () => {
  const login = await flow.login({ email: 'chef@g.tn', password: 'Chef-Passwort-2026', device: handy.proof() });
  licSvc.revokeDevice(adminId, handy.requestId);
  await sync();
  assert.equal(gate.isDeviceRevoked(handy.requestId), true);
  await assert.rejects(flow.login({ email: 'chef@g.tn', password: 'Chef-Passwort-2026', device: handy.proof() }),
    (e: AuthError) => e.status === 403);
  await assert.rejects(flow.refresh(login.refreshToken), (e: AuthError) => e.status === 403);
});

test('Gerätezertifikat eines anderen Kunden wird abgewiesen', async () => {
  const other = licSvc.createLicensee(adminId, { name: 'Anderer Händler', maxDevices: 1, paidUntil: '2099-12-31' });
  const dev = new Device('Fremd', 'pos');
  const r = licSvc.requestActivation({ installationId: other.installationId, name: dev.name, kind: dev.kind, publicKey: dev.publicKey });
  dev.certificate = licSvc.approveDevice(adminId, r.requestId);
  await assert.rejects(flow.login({ email: 'chef@g.tn', password: 'Chef-Passwort-2026', device: dev.proof() }),
    (e: AuthError) => /anderen Kunden/.test(e.message));
});

test('Internetausfall: Laden läuft 14 Tage weiter, danach nur Lesen', async () => {
  const deadServer = { ...inst, serverUrl: 'http://127.0.0.1:1' };
  const r = await syncLicense(gate, deadServer);
  assert.equal(r.ok, false);
  assert.equal(gate.status().mode, 'active');
  assert.equal(gate.allowsWrite(), true);
  now += 15 * 86_400;
  assert.equal(gate.status().mode, 'read_only');
  assert.equal(gate.allowsWrite(), false);
  // Verbindung wieder da -> sofort wieder aktiv (Lizenzserver-Uhr = echte Zeit, daher Uhr zurücksetzen)
  now = Math.floor(Date.now() / 1000);
  await sync();
  assert.equal(gate.status().mode, 'active');
});

test('Miete abgelaufen: Warnung, dann Nur-Lesen – Anmeldung bleibt möglich', async () => {
  licSvc.updateLicensee(adminId, inst.installationId, { paidUntil: '2020-01-01' });
  await sync();
  assert.equal(gate.status().mode, 'read_only');
  assert.equal(gate.allowsWrite(), false);
  const login = await flow.login({ email: 'chef@g.tn', password: 'Chef-Passwort-2026', device: kasse.proof() });
  assert.equal(login.license.mode, 'read_only');
  licSvc.updateLicensee(adminId, inst.installationId, { paidUntil: '2099-12-31' });
  await sync();
});

test('Gespeicherte Lizenz überlebt einen Neustart; manipulierte wird verworfen', async () => {
  const fresh = new LicenseGate(licPub, inst.installationId, { load: async () => savedLicense, save: async () => {} }, clock);
  await fresh.init();
  assert.equal(fresh.status().mode, 'active');
  const [body, sig] = savedLicense!.split('.');
  const evil = JSON.parse(Buffer.from(body, 'base64url').toString());
  evil.graceUntil += 10 * 365 * 86_400;
  const tampered = `${Buffer.from(JSON.stringify(evil)).toString('base64url')}.${sig}`;
  const g2 = new LicenseGate(licPub, inst.installationId, { load: async () => tampered, save: async () => {} }, clock);
  await g2.init();
  assert.equal(g2.status().mode, 'unlicensed');
});

test('JWT: Ablauf, Manipulation und fremde Schlüssel werden abgewiesen', () => {
  const t = signJwt({ sub: 'u', tid: 't', role: 'cashier', did: 'd' }, jwtKeys.privateKey, 60, now);
  assert.equal(verifyJwt(t, jwtKeys.publicKey, now).role, 'cashier');
  assert.throws(() => verifyJwt(t, jwtKeys.publicKey, now + 61), JwtError);
  const [h, p, s] = t.split('.');
  const asOwner = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url').toString()), role: 'owner' })).toString('base64url');
  assert.throws(() => verifyJwt(`${h}.${asOwner}.${s}`, jwtKeys.publicKey, now), JwtError);
  const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  assert.throws(() => verifyJwt(`${none}.${p}.`, jwtKeys.publicKey, now), JwtError);
  assert.throws(() => verifyJwt(t, generateKeyPairSync('ed25519').publicKey, now), JwtError);
});
