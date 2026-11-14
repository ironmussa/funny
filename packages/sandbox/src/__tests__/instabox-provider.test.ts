import { describe, expect, test } from 'bun:test';

import type { SandboxError } from '../contract.js';
import {
  createInstaboxProvider,
  instaboxTemplateName,
} from '../providers/instabox/instabox-provider.js';
import { expectOk, runSandboxProviderContract } from '../testing/provider-contract.js';
import { createInstaboxApiFake, KNOWN_TEMPLATE_SNAPSHOT_ID } from './instabox-api-fake.js';

const BASE = { apiBaseUrl: 'https://instabox.test' };

// One fake API per provider so every contract test starts clean.
const providerWith = (key: string, config: Record<string, unknown> = {}) => {
  const api = createInstaboxApiFake();
  return Object.assign(
    createInstaboxProvider(
      key,
      { ...BASE, ...config },
      { fetch: api.fetch, sleep: async () => {}, pollMs: 1 },
    ),
    { api },
  );
};

runSandboxProviderContract('instabox (emulated API)', {
  provider: () => providerWith('ibk_test_key'),
  providerWithBadCredential: () => providerWith('ibk_wrong'),
  knownVersion: '0.0.0-test',
});

describe('instabox adapter specifics', () => {
  test('template names fit InstaBox snapshot names', () => {
    expect(instaboxTemplateName('0.0.0-Test_1')).toBe('funny-runner-0-0-0-test-1');
    expect(instaboxTemplateName('x'.repeat(100))).toHaveLength(63);
  });

  test('create sends snapshot, size, env, archive deadline and the idempotency key', async () => {
    const provider = providerWith('ibk_test_key', { autoSuspendAfterSeconds: 0 });
    const template = expectOk(await provider.resolveTemplate('0.0.0-test'));
    expect(template.ref).toBe(KNOWN_TEMPLATE_SNAPSHOT_ID);
    expectOk(
      await provider.create({
        ownerKey: 't1',
        sizeId: 'small',
        template,
        env: { TEAM_SERVER_URL: 'https://funny.test' },
        lifetimeMs: 2 * 60 * 60 * 1000,
        idempotencyKey: 't1:0',
      }),
    );
    const create = provider.api.requests.find(
      (r) => r.method === 'POST' && r.path === '/v1/machines',
    );
    expect(create?.headers['idempotency-key']).toBe('t1:0');
    expect(create?.headers['x-api-key']).toBe('ibk_test_key');
    expect(create?.body).toEqual({
      snapshotId: KNOWN_TEMPLATE_SNAPSHOT_ID,
      vcpus: 2,
      memMiB: 4096,
      env: { TEAM_SERVER_URL: 'https://funny.test' },
      autoSuspendAfterSeconds: 0,
      archiveSeconds: 7200,
      metadata: { 'funny-thread': 't1' },
    });
  });

  test('a running machine that is not ready yet is still provisioning', async () => {
    const provider = providerWith('ibk_test_key');
    const handle = expectOk(
      await provider.create({ ownerKey: 't1', sizeId: 'default', env: {}, idempotencyKey: 'k' }),
    );
    provider.api.machines.get(handle.sandboxId)!.ready = false;
    expect(expectOk(await provider.status(handle)).state).toBe('provisioning');
  });

  test('stopping a paused machine succeeds without calling stop', async () => {
    const provider = providerWith('ibk_test_key');
    const handle = expectOk(
      await provider.create({ ownerKey: 't1', sizeId: 'default', env: {}, idempotencyKey: 'k' }),
    );
    provider.api.machines.get(handle.sandboxId)!.state = 'suspended';
    expectOk(await provider.stop(handle));
    expect(provider.api.requests.some((r) => r.path.endsWith('/stop'))).toBe(false);
    expectOk(await provider.resume(handle));
    expect(expectOk(await provider.status(handle)).state).toBe('running');
  });

  test('destroy confirms with the machine id', async () => {
    const provider = providerWith('ibk_test_key');
    const handle = expectOk(
      await provider.create({ ownerKey: 't1', sizeId: 'default', env: {}, idempotencyKey: 'k' }),
    );
    expectOk(await provider.destroy(handle));
    const del = provider.api.requests.find((r) => r.method === 'DELETE');
    expect(del?.headers['x-confirm-delete']).toBe(handle.sandboxId);
    expect(del?.headers['idempotency-key']).toBeTruthy();
  });

  test('maps InstaBox errors onto normalized kinds', async () => {
    const provider = providerWith('ibk_test_key');
    const failure = (code: string, extra: Record<string, unknown> = {}) => ({
      error: { code, message: code, retryable: false, ...extra },
    });
    const cases: Array<[number, any, SandboxError['kind']]> = [
      [401, failure('revoked_key'), 'auth'],
      [403, failure('missing_scope', { requiredScopes: ['images:write'] }), 'auth'],
      [403, failure('template_not_allowed'), 'unsupported'],
      [400, failure('spec_not_allowed'), 'unsupported'],
      [402, failure('credit_exhausted'), 'quota'],
      [404, failure('not_found'), 'not-found'],
      [409, failure('machine_not_running'), 'unavailable'],
      [
        409,
        failure('machine_cooldown', { retryable: true, retryAfterSeconds: 300 }),
        'unavailable',
      ],
      [429, failure('rate_limited', { retryable: true, retryAfterSeconds: 7 }), 'rate-limited'],
      [429, failure('concurrency_limit', { retryable: true }), 'rate-limited'],
      [429, failure('quota_exceeded'), 'quota'],
      [503, failure('no_capacity', { retryable: true, retryAfterSeconds: 60 }), 'unavailable'],
      [409, failure('idempotency_conflict'), 'provider'],
    ];
    for (const [status, body, kind] of cases) {
      provider.api.respondOnce(status, body);
      const result = await provider.validate();
      expect([body.error.code, result.isErr() && result.error.kind]).toEqual([
        body.error.code,
        kind,
      ]);
    }
    provider.api.respondOnce(
      429,
      failure('rate_limited', { retryable: true, retryAfterSeconds: 7 }),
    );
    const limited = await provider.validate();
    expect(
      limited.isErr() && limited.error.kind === 'rate-limited' && limited.error.retryAfterMs,
    ).toBe(7000);
    provider.api.respondOnce(403, failure('missing_scope', { requiredScopes: ['images:write'] }));
    const scoped = await provider.validate();
    expect(scoped.isErr() && scoped.error.message).toContain('images:write');
  });

  test('an account that still needs an invite fails validation with a quota error', async () => {
    const provider = providerWith('ibk_test_key');
    provider.api.respondOnce(200, { login: 'x', activated: false, inviteRequired: true });
    const result = await provider.validate();
    expect(result.isErr() && result.error.kind).toBe('quota');
  });

  test('exec runs a shell command and reports its exit code', async () => {
    const provider = providerWith('ibk_test_key');
    const handle = expectOk(
      await provider.create({ ownerKey: 't1', sizeId: 'default', env: {}, idempotencyKey: 'k' }),
    );
    const result = expectOk(await provider.exec(handle, 'echo hi', { timeoutMs: 30_000 }));
    expect(result).toEqual({ exitCode: 0, stdout: 'ok', stderr: '' });
    const sent = provider.api.requests.find((r) => r.path.endsWith('/exec'));
    expect(sent?.body).toEqual({ cmd: 'echo hi', timeoutSeconds: 30, noHistory: true });
  });

  test('buildTemplate installs, stops, snapshots and always deletes the throwaway machine', async () => {
    const provider = providerWith('ibk_test_key');
    const ref = expectOk(
      await provider.buildTemplate!({
        serverVersion: 'abc123def456',
        installScript: 'echo install',
        scriptEnv: { FUNNY_COMMIT: 'f'.repeat(40) },
      }),
    );
    const saved = provider.api.snapshots.get(ref.ref);
    expect(saved).toMatchObject({ name: 'funny-runner-abc123def456', status: 'ready' });
    expect(provider.api.commands[0].cmd).toContain('echo install');
    expect(provider.api.commands[0].cmd).toContain(`FUNNY_COMMIT='${'f'.repeat(40)}'`);
    expect(provider.api.machines.size).toBe(0);
    const throwaway = provider.api.requests.find(
      (r) => r.method === 'POST' && r.path === '/v1/machines',
    );
    expect(throwaway?.body?.deleteAfterSeconds).toBeGreaterThan(0);
    expect(expectOk(await provider.resolveTemplate('abc123def456')).ref).toBe(ref.ref);
  });

  test('buildTemplate replaces a failed snapshot that holds the name', async () => {
    const provider = providerWith('ibk_test_key');
    provider.api.snapshots.set('sn_failed', {
      id: 'sn_failed',
      name: 'funny-runner-v2',
      status: 'failed',
    });
    const missing = await provider.resolveTemplate('v2');
    expect(missing.isErr() && missing.error.kind).toBe('template-missing');
    expectOk(
      await provider.buildTemplate!({ serverVersion: 'v2', installScript: '', scriptEnv: {} }),
    );
    expect(provider.api.snapshots.has('sn_failed')).toBe(false);
  });

  test('buildTemplate waits for a pending snapshot of the same name instead of colliding', async () => {
    const provider = providerWith('ibk_test_key');
    provider.api.snapshots.set('sn_pending', {
      id: 'sn_pending',
      name: 'funny-runner-v2',
      status: 'pending',
    });
    const result = await provider.buildTemplate!({
      serverVersion: 'v2',
      installScript: '',
      scriptEnv: {},
    });
    expect(result.isErr() && result.error.kind).toBe('unavailable');
    expect(provider.api.snapshots.has('sn_pending')).toBe(true);
    expect(
      provider.api.requests.some((r) => r.method === 'POST' && r.path === '/v1/machines'),
    ).toBe(false);
  });

  test('buildTemplate reuses a ready snapshot of the same name without building', async () => {
    const provider = providerWith('ibk_test_key');
    provider.api.snapshots.set('sn_ready', {
      id: 'sn_ready',
      name: 'funny-runner-v2',
      status: 'ready',
    });
    const template = expectOk(
      await provider.buildTemplate!({ serverVersion: 'v2', installScript: '', scriptEnv: {} }),
    );
    expect(template.ref).toBe('sn_ready');
    expect(
      provider.api.requests.some((r) => r.method === 'POST' && r.path === '/v1/machines'),
    ).toBe(false);
  });

  test('a failed install surfaces the error and still deletes the throwaway machine', async () => {
    const provider = providerWith('ibk_test_key');
    provider.api.failNextCommand(2);
    const result = await provider.buildTemplate!({
      serverVersion: 'v-broken',
      installScript: 'exit 2',
      scriptEnv: {},
    });
    expect(result.isErr() && result.error.kind).toBe('provider');
    expect(provider.api.machines.size).toBe(0);
    expect(
      [...provider.api.snapshots.values()].some((s) => s.name === 'funny-runner-v-broken'),
    ).toBe(false);
  });

  test('templates are listed by name prefix and deleted by id', async () => {
    const provider = providerWith('ibk_test_key');
    provider.api.snapshots.set('sn_other', { id: 'sn_other', name: 'unrelated', status: 'ready' });
    const listed = expectOk(await provider.listTemplates!());
    expect(listed.map((t) => t.ref)).toEqual([KNOWN_TEMPLATE_SNAPSHOT_ID]);
    expectOk(await provider.deleteTemplate!(listed[0]));
    expectOk(await provider.deleteTemplate!({ providerId: 'instabox', ref: 'sn_gone' }));
    expect(provider.api.snapshots.has('sn_other')).toBe(true);
    expect(provider.api.snapshots.has(KNOWN_TEMPLATE_SNAPSHOT_ID)).toBe(false);
  });

  test('a hung InstaBox request times out as a transient error', async () => {
    const hung = (_url: string, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      });
    const provider = createInstaboxProvider('ibk_test_key', BASE, {
      fetch: hung,
      requestTimeoutMs: 20,
    });
    const result = await provider.status({ providerId: 'instabox', sandboxId: 'm_1' });
    expect(result.isErr() && result.error.kind).toBe('unavailable');
    expect(result.isErr() && result.error.message).toContain('timed out');
  });

  test('exposePort publishes a private port and returns its fresh token as a bearer header', async () => {
    const provider = providerWith('ibk_test_key');
    const handle = expectOk(
      await provider.create({ ownerKey: 't1', sizeId: 'default', env: {}, idempotencyKey: 't1:0' }),
    );
    const first = expectOk(await provider.exposePort!(handle, 7810));
    expect(first.url).toBe(`https://7810-${handle.sandboxId.slice(2)}.instabox.test`);
    expect(first.headers.Authorization).toMatch(/^Bearer ibp_/);
    // The token is only shown when issued, so a second call rotates it.
    const second = expectOk(await provider.exposePort!(handle, 7810));
    expect(second.headers.Authorization).not.toBe(first.headers.Authorization);
    const publish = provider.api.requests.find((r) => r.path.endsWith('/ports'));
    expect(publish?.body).toMatchObject({ port: 7810, access: 'private', rotateToken: true });
    expect(publish?.headers['idempotency-key']).toBeTruthy();
  });
});
