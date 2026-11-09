import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  configureSecretSource,
  createFileSecretSource,
  createReadOnlySecretSource,
  deriveServerKey,
  getAuthSecret,
  resetServerSecretsForTests,
} from '../../lib/server-secrets.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'funny-secrets-'));
  resetServerSecretsForTests();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  resetServerSecretsForTests();
});

describe('file secret source', () => {
  test('prefers the environment over the data dir file', () => {
    writeFileSync(join(dir, 'auth-secret'), 'from-file');
    configureSecretSource(
      createFileSecretSource({ env: { BETTER_AUTH_SECRET: 'from-env' }, dataDir: dir }),
    );
    expect(getAuthSecret()).toBe('from-env');
  });

  test('reads the data dir file when the env var is unset', () => {
    writeFileSync(join(dir, 'auth-secret'), 'from-file\n');
    configureSecretSource(createFileSecretSource({ env: {}, dataDir: dir }));
    expect(getAuthSecret()).toBe('from-file');
  });

  test('generates and stores an owner-only secret when none exists', () => {
    configureSecretSource(createFileSecretSource({ env: {}, dataDir: dir }));
    const secret = getAuthSecret();
    expect(secret).toHaveLength(128);
    const path = join(dir, 'auth-secret');
    expect(readFileSync(path, 'utf-8')).toBe(secret);
    expect(statSync(path).mode & 0o777).toBe(0o600);

    // A restart reads the stored value back instead of generating a new one.
    resetServerSecretsForTests();
    configureSecretSource(createFileSecretSource({ env: {}, dataDir: dir }));
    expect(getAuthSecret()).toBe(secret);
  });
});

describe('read-only secret source', () => {
  test('returns configured bindings', () => {
    configureSecretSource(createReadOnlySecretSource({ 'auth-secret': 'bound' }));
    expect(getAuthSecret()).toBe('bound');
  });

  test('refuses to generate a secret it cannot store', () => {
    configureSecretSource(createReadOnlySecretSource({}));
    expect(() => getAuthSecret()).toThrow(/BETTER_AUTH_SECRET/);
  });
});

describe('deriveServerKey', () => {
  test('is stable for the same auth secret and changes with it', () => {
    configureSecretSource(createReadOnlySecretSource({ 'auth-secret': 'secret-a' }));
    const first = deriveServerKey('oauth-callback-state');
    expect(first).toHaveLength(32);

    resetServerSecretsForTests();
    configureSecretSource(createReadOnlySecretSource({ 'auth-secret': 'secret-a' }));
    expect(deriveServerKey('oauth-callback-state').equals(first)).toBe(true);

    configureSecretSource(createReadOnlySecretSource({ 'auth-secret': 'secret-b' }));
    expect(deriveServerKey('oauth-callback-state').equals(first)).toBe(false);
  });

  test('is not the auth secret itself', () => {
    configureSecretSource(createReadOnlySecretSource({ 'auth-secret': 'secret-a' }));
    expect(deriveServerKey('oauth-callback-state').toString('utf-8')).not.toContain('secret-a');
  });
});
