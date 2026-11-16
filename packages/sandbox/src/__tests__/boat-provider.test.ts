import { describe, expect, test } from 'bun:test';

import type { SandboxError } from '../contract.js';
import { boatTemplateName, createBoatProvider } from '../providers/boat/boat-provider.js';
import { expectOk, runSandboxProviderContract } from '../testing/provider-contract.js';
import { createBoatApiFake } from './boat-api-fake.js';

const BASE = { apiBaseUrl: 'https://boat.test/api/v1' };

// One fake API per provider so every contract test starts clean.
const providerWith = (key: string) => {
  const api = createBoatApiFake();
  return Object.assign(
    createBoatProvider(key, BASE, {
      fetch: api.fetch,
      sleep: async () => {},
      pollMs: 1,
    }),
    { api },
  );
};

runSandboxProviderContract('boat (emulated API)', {
  provider: () => providerWith('boat_test_key'),
  providerWithBadCredential: () => providerWith('boat_wrong'),
  knownVersion: '0.0.0-test',
  expire: (provider, handle) => (provider as any).api.expire(handle.sandboxId),
});

describe('boat adapter specifics', () => {
  test('create sends size, template, env, lifetime and the idempotency key', async () => {
    const provider = providerWith('boat_test_key');
    const template = expectOk(await provider.resolveTemplate('0.0.0-test'));
    expect(template.ref).toBe(boatTemplateName('0.0.0-test'));
    expectOk(
      await provider.create({
        ownerKey: 't1',
        sizeId: 'small',
        template,
        env: { TEAM_SERVER_URL: 'https://funny.test' },
        lifetimeMs: 4 * 60 * 60 * 1000,
        idempotencyKey: 't1:0',
      }),
    );
    const create = provider.api.requests.find(
      (r) => r.method === 'POST' && r.path === '/sandboxes',
    );
    expect(create?.headers['idempotency-key']).toBe('t1:0');
    expect(create?.body).toMatchObject({
      type: 'small',
      from: 'funny-runner-0.0.0-test',
      env: { TEAM_SERVER_URL: 'https://funny.test' },
      ttlSeconds: 14_400,
    });
  });

  test('destroy confirms with the sandbox id', async () => {
    const provider = providerWith('boat_test_key');
    const template = expectOk(await provider.resolveTemplate('0.0.0-test'));
    const handle = expectOk(
      await provider.create({
        ownerKey: 't1',
        sizeId: 'default',
        template,
        env: {},
        idempotencyKey: 't1:0',
      }),
    );
    expectOk(await provider.destroy(handle));
    const del = provider.api.requests.find((r) => r.method === 'DELETE');
    expect(del?.headers['x-ascii-confirm-delete']).toBe(handle.sandboxId);
  });

  test('maps Boat errors onto normalized kinds', async () => {
    const provider = providerWith('boat_test_key');
    const cases: Array<[number, any, Record<string, string> | undefined, SandboxError['kind']]> = [
      [402, { ok: false, code: 'billing_required', message: 'Start the plan' }, undefined, 'quota'],
      [429, { ok: false, code: 'limit_reached', message: 'too many' }, undefined, 'quota'],
      [
        429,
        { ok: false, code: 'rate_limited', error: { details: { retryAfterSeconds: 7 } } },
        undefined,
        'rate-limited',
      ],
      [503, { ok: false, code: 'busy' }, { 'retry-after': '3' }, 'unavailable'],
      [409, { ok: false, code: 'snapshot_data_expired' }, undefined, 'expired'],
      [
        403,
        { ok: false, code: 'trial_saved_snapshots_not_allowed', message: 'trial' },
        undefined,
        'unsupported',
      ],
      [403, { ok: false, code: 'forbidden' }, undefined, 'auth'],
    ];
    for (const [status, body, headers, kind] of cases) {
      provider.api.respondOnce(status, body, headers);
      const result = await provider.validate();
      expect(result.isErr() && result.error.kind).toBe(kind);
    }
    provider.api.respondOnce(429, {
      ok: false,
      code: 'rate_limited',
      error: { details: { retryAfterSeconds: 7 } },
    });
    const limited = await provider.validate();
    expect(
      limited.isErr() && limited.error.kind === 'rate-limited' && limited.error.retryAfterMs,
    ).toBe(7000);
  });

  test('a blocked trial account fails validation with an actionable quota error', async () => {
    const provider = providerWith('boat_test_key');
    provider.api.respondOnce(200, {
      ok: true,
      accessTier: 'trial',
      blockedReason: 'subscription_required',
    });
    const result = await provider.validate();
    expect(result.isErr() && result.error.kind).toBe('quota');
  });

  test('an expired stopped disk reports lost', async () => {
    const provider = providerWith('boat_test_key');
    const template = expectOk(await provider.resolveTemplate('0.0.0-test'));
    const handle = expectOk(
      await provider.create({
        ownerKey: 't1',
        sizeId: 'default',
        template,
        env: {},
        idempotencyKey: 'k',
      }),
    );
    expectOk(await provider.stop(handle));
    provider.api.expire(handle.sandboxId);
    expect(expectOk(await provider.status(handle)).state).toBe('lost');
  });

  test('exec runs a command and reports its exit code', async () => {
    const provider = providerWith('boat_test_key');
    const handle = expectOk(
      await provider.create({ ownerKey: 't1', sizeId: 'small', env: {}, idempotencyKey: 'k' }),
    );
    const result = expectOk(await provider.exec(handle, 'echo hi', { timeoutMs: 30_000 }));
    expect(result).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
    const sent = provider.api.requests.find((r) => r.path.endsWith('/commands'));
    expect(sent?.body).toEqual({ command: 'echo hi', timeoutSeconds: 30 });
  });

  test('writeFile writes through the files API, never as a command', async () => {
    const provider = providerWith('boat_test_key');
    const handle = expectOk(
      await provider.create({ ownerKey: 't1', sizeId: 'small', env: {}, idempotencyKey: 'k' }),
    );
    expectOk(await provider.writeFile!(handle, '/home/user/.secret', 's3cret'));
    const sent = provider.api.requests.find((r) => r.path.endsWith('/files'));
    expect(sent).toMatchObject({
      method: 'PUT',
      body: { path: '/home/user/.secret', content: 's3cret' },
    });
    expect(provider.api.files.get(`${handle.sandboxId}:/home/user/.secret`)).toBe('s3cret');
    expect(provider.api.commands).toHaveLength(0);
    expect((await provider.writeFile!(handle, '/etc/secret', 'x')).isErr()).toBe(true);
  });

  test('buildTemplate installs, saves the snapshot and always deletes the throwaway sandbox', async () => {
    const provider = providerWith('boat_test_key');
    const ref = expectOk(
      await provider.buildTemplate!({
        serverVersion: 'abc123def456',
        installScript: 'echo install',
        scriptEnv: { FUNNY_COMMIT: 'f'.repeat(40) },
      }),
    );
    expect(ref.ref).toBe('funny-runner-abc123def456');
    expect(provider.api.commands[0].command).toContain('echo install');
    expect(provider.api.commands[0].command).toContain(`FUNNY_COMMIT='${'f'.repeat(40)}'`);
    expect(provider.api.sandboxes.size).toBe(0);
    expect(expectOk(await provider.resolveTemplate('abc123def456')).ref).toBe(ref.ref);
  });

  test('a failed install surfaces the error and still deletes the throwaway sandbox', async () => {
    const provider = providerWith('boat_test_key');
    provider.api.failNextCommand(2);
    const result = await provider.buildTemplate!({
      serverVersion: 'v-broken',
      installScript: 'exit 2',
      scriptEnv: {},
    });
    expect(result.isErr() && result.error.kind).toBe('provider');
    expect(provider.api.sandboxes.size).toBe(0);
    expect(provider.api.savedSnapshots.has('funny-runner-v-broken')).toBe(false);
  });

  test('templates are listed and deleted by name', async () => {
    const provider = providerWith('boat_test_key');
    provider.api.savedSnapshots.add('unrelated-snapshot');
    const listed = expectOk(await provider.listTemplates!()).map((t) => t.ref);
    expect(listed).toEqual(['funny-runner-0.0.0-test']);
    expectOk(await provider.deleteTemplate!(listed.map((ref) => ({ providerId: 'boat', ref }))[0]));
    expectOk(await provider.deleteTemplate!({ providerId: 'boat', ref: 'funny-runner-gone' }));
    expect(provider.api.savedSnapshots.has('unrelated-snapshot')).toBe(true);
  });

  test('a hung Boat request times out as a transient error instead of blocking forever', async () => {
    // A request that never answers, but honors its abort signal like fetch does.
    const hung = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    const provider = createBoatProvider('boat_test_key', BASE, {
      fetch: hung,
      requestTimeoutMs: 20,
    });
    const result = await provider.status({ providerId: 'boat', sandboxId: 'sb-1' });
    expect(result.isErr() && result.error.kind).toBe('unavailable');
    expect(result.isErr() && result.error.message).toContain('timed out');
  });

  test('exposePort publishes a token-gated URL for the port', async () => {
    const provider = providerWith('boat_test_key');
    const handle = expectOk(
      await provider.create({ ownerKey: 't1', sizeId: 'default', env: {}, idempotencyKey: 't1:0' }),
    );
    const ingress = expectOk(await provider.exposePort!(handle, 7810));
    expect(ingress.url).toBe(
      `https://${handle.sandboxId}-7810.on.boat.test?_token=tok_${handle.sandboxId}`,
    );
    expect(ingress.headers).toEqual({});
    const host = provider.api.requests.find(
      (r) => r.path === `/sandboxes/${handle.sandboxId}/host`,
    );
    expect(host?.body).toMatchObject({ port: 7810, public: false });
  });
});
