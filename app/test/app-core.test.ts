import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { publicKeyToB64, signChallenge, verifyChallenge } from '../../shared/license-core.ts';
import { activationStatusKey, nextActivationStep } from '../src/core/activation.ts';
import { decodeBase64Url } from '../src/core/base64url.ts';
import { challengeMessage, publicKeyToSpkiBase64, signatureToBase64Url } from '../src/core/challenge.ts';
import {
  DEVICE_IDENTITY_KEY, generateIdentity, loadOrCreateIdentity, signingKey,
  type DeviceIdentity, type KeyPairFromSeed, type SecureStoreLike,
} from '../src/core/identity.ts';
import { DEFAULT_LANGUAGE, directionForLanguage, LANGUAGE_KEY, loadLanguage, saveLanguage } from '../src/core/language.ts';
import { licenseBannerKey } from '../src/core/license.ts';
import { formatTndMinor } from '../src/core/money.ts';
import { normalizeServerUrl, ServerUrlError } from '../src/core/server-url.ts';
import { resources } from '../src/i18n/translations.ts';

class MemorySecureStore implements SecureStoreLike {
  readonly values = new Map<string, string>();
  async getItemAsync(key: string) { return this.values.get(key) ?? null; }
  async setItemAsync(key: string, value: string) { this.values.set(key, value); }
  async deleteItemAsync(key: string) { this.values.delete(key); }
}

/** Ed25519 aus Seed mit Node – gleiche Mathematik wie tweetnacl `sign.keyPair.fromSeed`. */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const nodePrivateKey = (seed: Uint8Array) =>
  createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' });
const nodeFromSeed: KeyPairFromSeed = (seed) => {
  const der = createPublicKey(nodePrivateKey(seed)).export({ type: 'spki', format: 'der' });
  const pub = new Uint8Array(der.subarray(der.length - 32));
  return { publicKey: pub, secretKey: new Uint8Array([...seed, ...pub]) };
};

test('Challenge-Signatur ist bytegenau mit shared/license-core.ts kompatibel', () => {
  const keys = generateKeyPairSync('ed25519');
  const challenge = 'test-challenge-2026';
  const signature = sign(null, challengeMessage(challenge), keys.privateKey);
  assert.equal(verifyChallenge(challenge, signatureToBase64Url(signature), publicKeyToB64(keys.publicKey)), true);
  const publicDer = keys.publicKey.export({ type: 'spki', format: 'der' });
  assert.equal(publicKeyToSpkiBase64(publicDer.subarray(publicDer.length - 32)), publicKeyToB64(keys.publicKey));
  const serverSignature = signChallenge(challenge, keys.privateKey);
  assert.equal(verify(null, challengeMessage(challenge), keys.publicKey, Buffer.from(serverSignature, 'base64url')), true);
});

test('Befund 1: Identität aus externer Zufallsquelle – Server akzeptiert die Signatur', () => {
  let requested = 0;
  const identity = generateIdentity((n) => { requested = n; return new Uint8Array(randomBytes(n)); }, nodeFromSeed);
  assert.equal(requested, 32, 'genau 32 Byte Seed aus der Zufallsquelle');

  const seed = decodeBase64Url(identity.privateKey);
  assert.equal(seed.length, 32);
  const challenge = 'c-' + randomBytes(8).toString('hex');
  const sig = sign(null, challengeMessage(challenge), nodePrivateKey(seed));
  assert.equal(verifyChallenge(challenge, signatureToBase64Url(sig), identity.publicKey), true,
    'öffentlicher Schlüssel der Identität passt zum gespeicherten Seed');

  assert.deepEqual(signingKey(identity, nodeFromSeed).slice(0, 32), seed);
  const legacy: DeviceIdentity = { ...identity, privateKey: Buffer.from(nodeFromSeed(seed).secretKey).toString('base64url') };
  assert.deepEqual(signingKey(legacy, nodeFromSeed), signingKey(identity, nodeFromSeed), 'alte 64-Byte-Speicherung bleibt lesbar');
});

test('Befund 1: kaputte Zufallsquelle wird erkannt', () => {
  assert.throws(() => generateIdentity(() => new Uint8Array(16), nodeFromSeed), /32-Byte/);
  assert.throws(() => generateIdentity(() => new Uint8Array(32), nodeFromSeed), /Nullen/);
});

test('Befund 1: Laufzeit nutzt expo-crypto und nie den PRNG-losen nacl.sign.keyPair()', () => {
  const runtime = readFileSync(new URL('../src/device/runtime.ts', import.meta.url), 'utf8');
  assert.match(runtime, /from 'expo-crypto'/);
  assert.match(runtime, /nacl\.setPRNG\(/);
  assert.match(runtime, /getRandomBytes/);
  assert.doesNotMatch(runtime, /nacl\.sign\.keyPair\(\)/);
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dependencies: Record<string, string> };
  assert.ok(pkg.dependencies['expo-crypto'], 'expo-crypto ist Abhängigkeit');
});

test('Geräteidentität wird im SecureStore wiederverwendet und nicht neu erzeugt', async () => {
  const store = new MemorySecureStore();
  let generated = 0;
  const create = async (): Promise<DeviceIdentity> => { generated++; return { publicKey: `p${generated}`, privateKey: `k${generated}` }; };
  const first = await loadOrCreateIdentity(store, create);
  assert.deepEqual(await loadOrCreateIdentity(store, create), first);
  assert.equal(generated, 1);
  assert.ok(await store.getItemAsync(DEVICE_IDENTITY_KEY));
});

test('Befund 2: Sprache wird gespeichert und beim Start gelesen; Richtung je Sprache', async () => {
  const store = new MemorySecureStore();
  assert.equal(await loadLanguage(store), DEFAULT_LANGUAGE);
  await saveLanguage(store, 'ar');
  assert.equal(store.values.get(LANGUAGE_KEY), 'ar');
  assert.equal(await loadLanguage(store), 'ar');
  store.values.set(LANGUAGE_KEY, 'xx');
  assert.equal(await loadLanguage(store), DEFAULT_LANGUAGE, 'unbekannter Wert -> Standard');
  assert.equal(directionForLanguage('ar'), 'rtl');
  assert.equal(directionForLanguage('fr'), 'ltr');
});

test('Befund 2: Richtungswechsel ohne Neustart (Layout-Stil statt forceRTL)', () => {
  const provider = readFileSync(new URL('../src/i18n/LanguageProvider.tsx', import.meta.url), 'utf8');
  assert.match(provider, /direction: value\.direction/);
  assert.doesNotMatch(provider, /I18nManager\.forceRTL\(|reloadAsync\(|DevSettings\.reload\(/);
});

test('Befund 4: keine festen Texte in Bildschirmen, alle Schlüssel in allen drei Sprachen', () => {
  for (const screen of ['index', 'setup', 'login', 'license']) {
    const src = readFileSync(new URL(`../app/${screen}.tsx`, import.meta.url), 'utf8');
    // Text zwischen JSX-Tags, der kein Ausdruck ist (z. B. >Zurück<)
    const literal = src.match(/>\s*[A-Za-zÀ-ÿ؀-ۿ][^<>{}]*</u);
    assert.equal(literal, null, `fester Text in ${screen}.tsx: ${literal?.[0]}`);
    assert.doesNotMatch(src, /setMessage\('|setError\('[A-ZÄÖÜ]/u, `feste Meldung in ${screen}.tsx`);
  }
  const paths = (o: object, prefix = ''): string[] => Object.entries(o).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? paths(v, `${prefix}${k}.`) : [`${prefix}${k}`]).sort();
  const en = paths(resources.en.translation);
  assert.deepEqual(paths(resources.fr.translation), en, 'fr hat dieselben Schlüssel wie en');
  assert.deepEqual(paths(resources.ar.translation), en, 'ar hat dieselben Schlüssel wie en');
  // Jeder in Bildschirmen verwendete Schlüssel existiert
  for (const screen of ['index', 'setup', 'login', 'license']) {
    const src = readFileSync(new URL(`../app/${screen}.tsx`, import.meta.url), 'utf8');
    for (const [, key] of src.matchAll(/\bt\('([\w.]+)'\)/g)) assert.ok(en.includes(key!), `${screen}.tsx: Schlüssel ${key} fehlt`);
  }
});

test('Befund 5: Freischaltung – weiter warten, fertig oder abgebrochen', () => {
  assert.equal(nextActivationStep('pending', false), 'wait');
  assert.equal(nextActivationStep('approved', false), 'wait', 'erst mit Zertifikat fertig');
  assert.equal(nextActivationStep('approved', true), 'done');
  assert.equal(nextActivationStep('rejected', false), 'failed');
  assert.equal(nextActivationStep('revoked', false), 'failed');
  assert.equal(activationStatusKey('approved'), 'activation.approved');
  assert.equal(activationStatusKey('???'), 'activation.pending');
});

test('Befund 6: nur https, http nur im Entwicklungsmodus', () => {
  assert.equal(normalizeServerUrl(' https://laden.local:8443/ ', { allowInsecure: false }), 'https://laden.local:8443');
  assert.equal(normalizeServerUrl('https://10.0.0.5/api', { allowInsecure: false }), 'https://10.0.0.5/api');
  assert.throws(() => normalizeServerUrl('http://laden.local', { allowInsecure: false }),
    (e: ServerUrlError) => e.reason === 'https_required');
  assert.equal(normalizeServerUrl('http://192.168.1.10:3000', { allowInsecure: true }), 'http://192.168.1.10:3000');
  for (const bad of ['laden.local', 'ftp://x', 'https://user:pw@x', 'https://x?a=1', 'javascript:alert(1)', '']) {
    assert.throws(() => normalizeServerUrl(bad, { allowInsecure: true }), ServerUrlError, bad);
  }
});

test('TND-Beträge bleiben in Minor Units und zeigen drei Nachkommastellen', () => {
  assert.match(formatTndMinor('1234567', 'fr-TN'), /1.?234,567/u);
  assert.equal(formatTndMinor('0', 'en-US'), '0.000');
  assert.throws(() => formatTndMinor('12.3', 'en-US'));
});

test('Lizenzmodus wird nur über i18n-Schlüssel dargestellt', () => {
  assert.equal(licenseBannerKey('active'), 'license.active');
  assert.equal(licenseBannerKey('read_only'), 'license.readOnly');
  assert.equal(licenseBannerKey('unlicensed'), 'license.unlicensed');
});
