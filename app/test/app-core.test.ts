import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign, verify } from 'node:crypto';
import { publicKeyToB64, signChallenge, verifyChallenge } from '../../shared/license-core.ts';
import { challengeMessage, publicKeyToSpkiBase64, signatureToBase64Url } from '../src/core/challenge.ts';
import { changeLanguage, directionForLanguage, type DraftState } from '../src/core/language.ts';
import { formatTndMinor } from '../src/core/money.ts';
import { licenseBannerKey } from '../src/core/license.ts';
import {
  DEVICE_IDENTITY_KEY, loadOrCreateIdentity, type DeviceIdentity, type SecureStoreLike,
} from '../src/core/identity.ts';

test('Challenge-Signatur ist bytegenau mit shared/license-core.ts kompatibel', () => {
  const keys = generateKeyPairSync('ed25519');
  const challenge = 'test-challenge-2026';
  const message = challengeMessage(challenge);
  const signature = sign(null, message, keys.privateKey);
  const signatureB64 = signatureToBase64Url(signature);
  assert.equal(verifyChallenge(challenge, signatureB64, publicKeyToB64(keys.publicKey)), true);

  const publicDer = keys.publicKey.export({ type: 'spki', format: 'der' });
  const rawPublic = publicDer.subarray(publicDer.length - 32);
  assert.equal(publicKeyToSpkiBase64(rawPublic), publicKeyToB64(keys.publicKey));

  const serverSignature = signChallenge(challenge, keys.privateKey);
  assert.equal(verify(null, message, keys.publicKey, Buffer.from(serverSignature, 'base64url')), true);
});

class MemorySecureStore implements SecureStoreLike {
  private readonly values = new Map<string, string>();
  async getItemAsync(key: string) { return this.values.get(key) ?? null; }
  async setItemAsync(key: string, value: string) { this.values.set(key, value); }
  async deleteItemAsync(key: string) { this.values.delete(key); }
}

test('Geräteidentität wird im SecureStore wiederverwendet und nicht neu erzeugt', async () => {
  const store = new MemorySecureStore();
  let generated = 0;
  const create = async (): Promise<DeviceIdentity> => {
    generated++;
    return { publicKey: `public-${generated}`, privateKey: `private-${generated}` };
  };
  const first = await loadOrCreateIdentity(store, create);
  const second = await loadOrCreateIdentity(store, create);
  assert.equal(first.privateKey, 'private-1');
  assert.deepEqual(second, first);
  assert.equal(generated, 1);
  assert.ok(await store.getItemAsync(DEVICE_IDENTITY_KEY));
});

test('Sprachwechsel ändert RTL/LTR, verliert aber Formulardaten nicht', () => {
  const state: DraftState = { language: 'fr', direction: 'ltr', email: 'chef@g.tn', serverUrl: 'https://kunde.local' };
  const arabic = changeLanguage(state, 'ar');
  assert.equal(directionForLanguage('ar'), 'rtl');
  assert.equal(arabic.direction, 'rtl');
  assert.equal(arabic.email, state.email);
  assert.equal(arabic.serverUrl, state.serverUrl);
  assert.equal(changeLanguage(arabic, 'en').direction, 'ltr');
});

test('TND-Beträge bleiben in Minor Units und zeigen drei Nachkommastellen', () => {
  assert.match(formatTndMinor('1234567', 'fr-TN'), /1.?234,567/u);
  assert.equal(formatTndMinor('0', 'en-US'), '0.000');
  assert.throws(() => formatTndMinor('12.3', 'en-US'));
});

test('Lizenzmodus wird nur über i18n-Schlüssel dargestellt', () => {
  assert.equal(licenseBannerKey('active'), 'license.active');
  assert.equal(licenseBannerKey('warning'), 'license.warning');
  assert.equal(licenseBannerKey('read_only'), 'license.readOnly');
  assert.equal(licenseBannerKey('unlicensed'), 'license.unlicensed');
});
