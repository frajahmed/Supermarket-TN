import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateTotpCode, matchingTotpStep } from '../src/core/totp.ts';

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
