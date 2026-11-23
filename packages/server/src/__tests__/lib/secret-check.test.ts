/**
 * Security CR-1 regression — refuse to boot when shared secrets are
 * identical. `findDuplicateSecretPairs` is the pure helper that drives the
 * boot-time check in `index.ts`; this test pins its behaviour.
 */
import { describe, expect, test } from 'bun:test';

import {
  findDuplicateSecretPairs,
  findWeakSecrets,
  MIN_SECRET_LENGTH,
} from '../../lib/secret-check.js';

describe('findDuplicateSecretPairs (security CR-1)', () => {
  test('returns no pairs when both are distinct', () => {
    const out = findDuplicateSecretPairs({
      RUNNER_AUTH_SECRET: 'a-1',
      INGEST_WEBHOOK_SECRET: 'b-2',
    });
    expect(out).toEqual([]);
  });

  test('flags RUNNER_AUTH_SECRET == INGEST_WEBHOOK_SECRET', () => {
    const out = findDuplicateSecretPairs({
      RUNNER_AUTH_SECRET: 'shared',
      INGEST_WEBHOOK_SECRET: 'shared',
    });
    expect(out).toEqual([['RUNNER_AUTH_SECRET', 'INGEST_WEBHOOK_SECRET']]);
  });

  test('ignores undefined values entirely', () => {
    const out = findDuplicateSecretPairs({
      RUNNER_AUTH_SECRET: undefined,
      INGEST_WEBHOOK_SECRET: 'only',
    });
    expect(out).toEqual([]);
  });

  test('ignores empty strings (treated as unset)', () => {
    const out = findDuplicateSecretPairs({
      RUNNER_AUTH_SECRET: '',
      INGEST_WEBHOOK_SECRET: '',
    });
    expect(out).toEqual([]);
  });

  test('only one secret set → no duplicates possible', () => {
    const out = findDuplicateSecretPairs({ RUNNER_AUTH_SECRET: 'only-one' });
    expect(out).toEqual([]);
  });
});

describe('findWeakSecrets (security — forgeable forwarded-identity HMAC key)', () => {
  const strong = 'a'.repeat(MIN_SECRET_LENGTH);

  test('flags a too-short RUNNER_AUTH_SECRET', () => {
    const out = findWeakSecrets({ RUNNER_AUTH_SECRET: 'secret' });
    expect(out).toEqual(['RUNNER_AUTH_SECRET']);
  });

  test('accepts a secret exactly at the minimum length', () => {
    expect(findWeakSecrets({ RUNNER_AUTH_SECRET: strong })).toEqual([]);
  });

  test('flags every present secret below the threshold', () => {
    const out = findWeakSecrets({
      RUNNER_AUTH_SECRET: 'short',
      INGEST_WEBHOOK_SECRET: 'weak',
    });
    expect(out).toEqual(['RUNNER_AUTH_SECRET', 'INGEST_WEBHOOK_SECRET']);
  });

  test('ignores undefined / empty (presence is enforced elsewhere)', () => {
    expect(findWeakSecrets({ RUNNER_AUTH_SECRET: undefined, INGEST_WEBHOOK_SECRET: '' })).toEqual(
      [],
    );
  });
});
