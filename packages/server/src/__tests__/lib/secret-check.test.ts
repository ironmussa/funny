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
  test('returns no pairs when all three are distinct', () => {
    const out = findDuplicateSecretPairs({
      RUNNER_AUTH_SECRET: 'a-1',
      INGEST_WEBHOOK_SECRET: 'b-2',
      ORCHESTRATOR_AUTH_SECRET: 'c-3',
    });
    expect(out).toEqual([]);
  });

  test('flags RUNNER_AUTH_SECRET == INGEST_WEBHOOK_SECRET', () => {
    const out = findDuplicateSecretPairs({
      RUNNER_AUTH_SECRET: 'shared',
      INGEST_WEBHOOK_SECRET: 'shared',
      ORCHESTRATOR_AUTH_SECRET: 'distinct',
    });
    expect(out).toEqual([['RUNNER_AUTH_SECRET', 'INGEST_WEBHOOK_SECRET']]);
  });

  test('flags all three when they are identical (3 pairs)', () => {
    const out = findDuplicateSecretPairs({
      RUNNER_AUTH_SECRET: 'same',
      INGEST_WEBHOOK_SECRET: 'same',
      ORCHESTRATOR_AUTH_SECRET: 'same',
    });
    expect(out).toHaveLength(3);
  });

  test('flags ORCHESTRATOR_AUTH_SECRET == INGEST_WEBHOOK_SECRET (no runner set)', () => {
    const out = findDuplicateSecretPairs({
      INGEST_WEBHOOK_SECRET: 'x',
      ORCHESTRATOR_AUTH_SECRET: 'x',
    });
    expect(out).toEqual([['INGEST_WEBHOOK_SECRET', 'ORCHESTRATOR_AUTH_SECRET']]);
  });

  test('ignores undefined values entirely', () => {
    const out = findDuplicateSecretPairs({
      RUNNER_AUTH_SECRET: undefined,
      INGEST_WEBHOOK_SECRET: undefined,
      ORCHESTRATOR_AUTH_SECRET: 'only',
    });
    expect(out).toEqual([]);
  });

  test('ignores empty strings (treated as unset)', () => {
    const out = findDuplicateSecretPairs({
      RUNNER_AUTH_SECRET: '',
      INGEST_WEBHOOK_SECRET: '',
      ORCHESTRATOR_AUTH_SECRET: '',
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
      INGEST_WEBHOOK_SECRET: strong,
      ORCHESTRATOR_AUTH_SECRET: 'weak',
    });
    expect(out).toEqual(['RUNNER_AUTH_SECRET', 'ORCHESTRATOR_AUTH_SECRET']);
  });

  test('ignores undefined / empty (presence is enforced elsewhere)', () => {
    expect(findWeakSecrets({ RUNNER_AUTH_SECRET: undefined, INGEST_WEBHOOK_SECRET: '' })).toEqual(
      [],
    );
  });
});
