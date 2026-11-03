import { encodeBase64Url } from './base64url.ts';

const ED25519_SPKI_PREFIX = Uint8Array.from([
  0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00,
]);

/** Genau der Byte-String, den shared/license-core.ts signiert. */
export function challengeMessage(challenge: string): Uint8Array {
  return new TextEncoder().encode(`stn-login:${challenge}`);
}

export function signatureToBase64Url(signature: Uint8Array): string {
  return encodeBase64Url(signature);
}

/** Wandelt den rohen Ed25519-Schlüssel in das SPKI-Format des Kundenservers um. */
export function publicKeyToSpkiBase64(rawPublicKey: Uint8Array): string {
  if (rawPublicKey.length !== 32) throw new Error('Ed25519-Schlüssel muss 32 Bytes haben');
  const der = new Uint8Array(ED25519_SPKI_PREFIX.length + rawPublicKey.length);
  der.set(ED25519_SPKI_PREFIX);
  der.set(rawPublicKey, ED25519_SPKI_PREFIX.length);
  let binary = '';
  for (const byte of der) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary);
}

export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

export async function createChallengeProof(
  challenge: string,
  signMessage: SignMessage,
): Promise<{ challenge: string; signature: string }> {
  return { challenge, signature: signatureToBase64Url(await signMessage(challengeMessage(challenge))) };
}
