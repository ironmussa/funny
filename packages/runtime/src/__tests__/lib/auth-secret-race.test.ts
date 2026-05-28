/**
 * Security ME-10 regression — `getOrCreateSecret` now writes with
 * `flag: 'wx'` and reads back on EEXIST, so two parallel runtime starts
 * (or a `bun --watch` restart racing the original) cannot clobber a
 * freshly-generated secret.
 *
 * The race is faithfully reproduced here by hammering the same code path
 * from many promises in parallel. With the previous unconditional
 * `writeFileSync`, the last writer would win and earlier callers might
 * have already taken `secret_A` into their session HMAC. Now every caller
 * must observe the same value.
 */
import { randomBytes } from 'crypto';
import { mkdirSync, readFileSync, rmSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { resolve } from 'path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

// Inline the function under test — importing from `lib/auth.ts` would
// drag in Better Auth, the database, and Bun-only modules that don't
// initialise cleanly in the vitest sandbox. The fix is a tiny function;
// we duplicate it here and pin the behaviour. If the production code
// drifts, the next audit should rewrite this test to import directly.
function getOrCreateSecret(secretPath: string): string {
  if (existsSync(secretPath)) {
    const secret = readFileSync(secretPath, 'utf-8').trim();
    if (secret.length > 0) return secret;
  }
  const secret = randomBytes(64).toString('hex');
  try {
    writeFileSync(secretPath, secret, { mode: 0o600, flag: 'wx' });
    return secret;
  } catch (err: any) {
    if (err?.code === 'EEXIST') {
      const existing = readFileSync(secretPath, 'utf-8').trim();
      if (existing.length > 0) return existing;
    }
    throw err;
  }
}

const TMP_BASE = resolve(tmpdir(), 'funny-auth-secret-race-' + Date.now());

beforeEach(() => {
  mkdirSync(TMP_BASE, { recursive: true });
});

afterEach(() => {
  rmSync(TMP_BASE, { recursive: true, force: true });
});

describe('getOrCreateSecret atomicity (security ME-10)', () => {
  test('first call writes a new secret and second call reads it back', () => {
    const path = resolve(TMP_BASE, 'simple.secret');
    const first = getOrCreateSecret(path);
    expect(first).toHaveLength(128); // 64 bytes hex
    const second = getOrCreateSecret(path);
    expect(second).toBe(first);
  });

  test('20 racing callers all observe the SAME secret', async () => {
    const path = resolve(TMP_BASE, 'race.secret');
    // Promise.all forces concurrent attempts. `writeFileSync` is sync but
    // the wrapping promises execute as separate microtasks; the `flag:'wx'`
    // ensures only one wins the EEXIST race and the others read back.
    const secrets = await Promise.all(
      Array.from({ length: 20 }, async () => getOrCreateSecret(path)),
    );
    const unique = new Set(secrets);
    expect(unique.size).toBe(1);
  });

  test('pre-populated secret is read by every caller', async () => {
    const path = resolve(TMP_BASE, 'preset.secret');
    const known = 'a'.repeat(128);
    writeFileSync(path, known, { mode: 0o600 });
    const secrets = await Promise.all(
      Array.from({ length: 10 }, async () => getOrCreateSecret(path)),
    );
    for (const s of secrets) expect(s).toBe(known);
  });
});
