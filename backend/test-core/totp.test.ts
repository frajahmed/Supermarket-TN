import { test } from 'node:test';
import assert from 'node:assert/strict';
import { base32Encode, generateTotpCode, generateTotpSecret, matchingTotpStep, totpUri } from '../src/core/totp.ts';

// RFC 6238 Appendix B: Secret 12345678901234567890 als Base32.
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('TOTP entspricht den RFC-6238-Testvektoren nach Kürzung auf sechs Stellen', () => {
  const vectors: Array<[number, string]> = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];
  for (const [timestamp, expected] of vectors) assert.equal(generateTotpCode(secret, timestamp), expected);
});

test('TOTP akzeptiert genau das vorige, aktuelle oder nächste 30-Sekunden-Fenster', () => {
  const now = 1_700_000_015;
  const previous = generateTotpCode(secret, now - 30);
  const current = generateTotpCode(secret, now);
  const next = generateTotpCode(secret, now + 30);
  assert.equal(matchingTotpStep(secret, previous, now), Math.floor(now / 30) - 1);
  assert.equal(matchingTotpStep(secret, current, now), Math.floor(now / 30));
  assert.equal(matchingTotpStep(secret, next, now), Math.floor(now / 30) + 1);
  assert.equal(matchingTotpStep(secret, '000000', now), null);
});

test('T-108: Base32 nach RFC 4648 und erzeugte Geheimnisse sind nutzbar', () => {
  // RFC 4648, Abschnitt 10 (ohne Auffüllzeichen)
  const vectors: Array<[string, string]> = [['', ''], ['f', 'MY'], ['fo', 'MZXQ'], ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'], ['fooba', 'MZXW6YTB'], ['foobar', 'MZXW6YTBOI']];
  for (const [input, expected] of vectors) assert.equal(base32Encode(Buffer.from(input)), expected);
  assert.equal(base32Encode(Buffer.from('12345678901234567890')), secret);

  const generated = generateTotpSecret();
  assert.match(generated, /^[A-Z2-7]{32}$/, '160 Bit = 32 Base32-Zeichen');
  assert.notEqual(generateTotpSecret(), generated, 'jedes Geheimnis ist neu');
  const code = generateTotpCode(generated, 1_700_000_000);
  assert.equal(matchingTotpStep(generated, code, 1_700_000_000), Math.floor(1_700_000_000 / 30));
});

test('T-108: otpauth-URI für Authenticator-Apps', () => {
  const uri = totpUri('JBSWY3DPEHPK3PXP', 'chef@grossiste.tn');
  assert.equal(uri,
    'otpauth://totp/Supermarket-TN%3Achef%40grossiste.tn?secret=JBSWY3DPEHPK3PXP&issuer=Supermarket-TN&algorithm=SHA1&digits=6&period=30');
});
