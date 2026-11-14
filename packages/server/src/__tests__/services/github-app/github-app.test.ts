import { describe, expect, test } from 'bun:test';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { okAsync } from 'neverthrow';

// The stored App's key is encrypted with the keyring: keep it out of ~/.funny.
process.env.FUNNY_DATA_DIR = mkdtempSync(join(tmpdir(), 'funny-github-app-test-'));

const { loadGithubAppConfig, saveGithubApp, deleteGithubApp } =
  await import('../../../services/github-app/app-config.js');
const { signAppJwt } = await import('@funny/core/github-app');
const { createGithubAppTokenIssuer, SANDBOX_PERMISSIONS } =
  await import('../../../services/github-app/token-issuer.js');

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k: string) => data.get(k) ?? null,
    set: async (k: string, v: string) => void data.set(k, v),
    delete: async (k: string) => void data.delete(k),
  };
}

describe('GitHub App config', () => {
  test('nothing configured', async () => {
    expect((await loadGithubAppConfig({}, memoryStore()))._unsafeUnwrap()).toBeNull();
  });

  test('from the environment, with one-line escaped newlines', async () => {
    const env = {
      GITHUB_APP_ID: '5690396',
      GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n'),
    };
    const config = (await loadGithubAppConfig(env, memoryStore()))._unsafeUnwrap();
    expect(config?.appId).toBe('5690396');
    expect(config?.privateKey).toBe(privateKey.trim());
    expect(config?.source).toBe('environment');
  });

  test('malformed environment values are an error, not a silent fallback', async () => {
    for (const env of [
      { GITHUB_APP_ID: '5690396' },
      { GITHUB_APP_PRIVATE_KEY: privateKey },
      { GITHUB_APP_ID: 'abc', GITHUB_APP_PRIVATE_KEY: privateKey },
      { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'not a key' },
    ]) {
      expect((await loadGithubAppConfig(env, memoryStore())).isErr()).toBe(true);
    }
  });

  test('stored by the manifest flow with the key encrypted; the environment wins', async () => {
    const store = memoryStore();
    await saveGithubApp(store, { appId: '42', slug: 'funny-x', owner: 'acme', privateKey });
    expect(JSON.stringify([...store.data.values()])).not.toContain('PRIVATE KEY');

    const stored = (await loadGithubAppConfig({}, store))._unsafeUnwrap();
    expect(stored).toMatchObject({
      appId: '42',
      slug: 'funny-x',
      owner: 'acme',
      source: 'database',
    });
    expect(stored?.privateKey).toBe(privateKey);

    const env = { GITHUB_APP_ID: '7', GITHUB_APP_PRIVATE_KEY: privateKey };
    expect((await loadGithubAppConfig(env, store))._unsafeUnwrap()?.appId).toBe('7');

    await deleteGithubApp(store);
    expect((await loadGithubAppConfig({}, store))._unsafeUnwrap()).toBeNull();
  });
});

describe('GitHub App JWT', () => {
  test('is RS256, verifies with the public key and expires within ten minutes', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    const jwt = signAppJwt('5690396', privateKey, now)._unsafeUnwrap();
    const [header, payload, signature] = jwt.split('.');
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({
      alg: 'RS256',
      typ: 'JWT',
    });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    const t = Math.floor(now.getTime() / 1000);
    expect(claims.iss).toBe('5690396');
    expect(claims.iat).toBe(t - 60);
    expect(claims.exp - t).toBeLessThanOrEqual(600);
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${header}.${payload}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true);
  });

  test('a bad key is an error', () => {
    expect(signAppJwt('1', 'not a key').isErr()).toBe(true);
  });
});

describe('GitHub App token issuer', () => {
  const OWNER_PAT = 'ghp_owner';
  const T0 = new Date('2026-11-10T12:00:00Z');

  function setup(
    opts: { permissions?: Record<string, boolean>; ownerStatus?: number; installed?: boolean } = {},
  ) {
    let clock = T0.getTime();
    const calls: Array<{ url: string; method: string; auth: string; body?: any }> = [];
    let minted = 0;
    const fetchFake = (async (url: string, init: RequestInit) => {
      const headers = init.headers as Record<string, string>;
      const call = {
        url,
        method: init.method ?? 'GET',
        auth: headers.authorization,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      };
      calls.push(call);
      const json = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), { status });
      if (url.endsWith('/repos/acme/app')) {
        return opts.ownerStatus
          ? json(opts.ownerStatus, {})
          : json(200, { permissions: opts.permissions ?? { push: true, pull: true } });
      }
      if (url.endsWith('/repos/acme/app/installation'))
        return opts.installed === false ? json(404, {}) : json(200, { id: 99 });
      if (url.endsWith('/app/installations/99/access_tokens')) {
        minted++;
        return json(201, {
          token: `ghs_${minted}`,
          expires_at: new Date(clock + 60 * 60 * 1000).toISOString(),
        });
      }
      return json(500, {});
    }) as unknown as typeof fetch;
    const issuer = createGithubAppTokenIssuer({
      app: () =>
        okAsync({
          appId: '5690396',
          privateKey,
          slug: null,
          owner: null,
          source: 'environment' as const,
        }),
      fetch: fetchFake,
      api: 'https://api.example',
      now: () => new Date(clock),
    });
    return { issuer, calls, advance: (ms: number) => (clock += ms) };
  }

  test('an owner with push gets a write token for exactly that repository', async () => {
    const { issuer, calls } = setup();
    const token = (await issuer.issue('Acme/App', OWNER_PAT))._unsafeUnwrap();
    expect(token).toMatchObject({ token: 'ghs_1', repo: 'acme/app', level: 'write' });
    // The owner's PAT is used only for the access check, against GitHub.
    expect(calls[0].auth).toBe(`Bearer ${OWNER_PAT}`);
    const mint = calls.find((c) => c.url.endsWith('/access_tokens'))!;
    expect(mint.auth).not.toContain(OWNER_PAT);
    expect(mint.body).toEqual({ repositories: ['app'], permissions: SANDBOX_PERMISSIONS.write });
    expect(JSON.stringify(token)).not.toContain(OWNER_PAT);
  });

  test('an owner with read only gets a read token, without workflows', async () => {
    const { issuer, calls } = setup({ permissions: { pull: true } });
    const token = (await issuer.issue('acme/app', OWNER_PAT))._unsafeUnwrap();
    expect(token.level).toBe('read');
    const mint = calls.find((c) => c.url.endsWith('/access_tokens'))!;
    expect(mint.body.permissions.contents).toBe('read');
    expect(mint.body.permissions.workflows).toBeUndefined();
  });

  test('an owner without access, or without a PAT, gets nothing and no token is minted', async () => {
    for (const opts of [{ ownerStatus: 404 }, { permissions: {} }]) {
      const { issuer, calls } = setup(opts);
      expect((await issuer.issue('acme/app', OWNER_PAT))._unsafeUnwrapErr().kind).toBe('no-access');
      expect(calls.some((c) => c.url.endsWith('/access_tokens'))).toBe(false);
    }
    const { issuer } = setup();
    expect((await issuer.issue('acme/app', null))._unsafeUnwrapErr().kind).toBe('no-access');
  });

  test('a repository without the App installed', async () => {
    const { issuer } = setup({ installed: false });
    expect((await issuer.issue('acme/app', OWNER_PAT))._unsafeUnwrapErr().kind).toBe(
      'not-installed',
    );
  });

  test('no App connected', async () => {
    const issuer = createGithubAppTokenIssuer({ app: () => okAsync(null) });
    expect((await issuer.issue('acme/app', OWNER_PAT))._unsafeUnwrapErr().kind).toBe(
      'not-configured',
    );
  });

  test('a token is reused until ten minutes before it expires, then re-minted', async () => {
    const { issuer, advance } = setup();
    expect((await issuer.issue('acme/app', OWNER_PAT))._unsafeUnwrap().token).toBe('ghs_1');
    advance(45 * 60 * 1000);
    expect((await issuer.issue('acme/app', OWNER_PAT))._unsafeUnwrap().token).toBe('ghs_1');
    advance(6 * 60 * 1000);
    expect((await issuer.issue('acme/app', OWNER_PAT))._unsafeUnwrap().token).toBe('ghs_2');
  });
});
