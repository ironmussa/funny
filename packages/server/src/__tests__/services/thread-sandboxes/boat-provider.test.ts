import { describe, expect, test } from 'bun:test';

import type { SandboxError } from '../../../services/thread-sandboxes/contract.js';
import {
  boatTemplateName,
  createBoatProvider,
} from '../../../services/thread-sandboxes/providers/boat/boat-provider.js';
import { createBoatApiFake } from './boat-api-fake.js';
import { expectOk, runSandboxProviderContract } from './provider-contract.js';

const BASE = { apiBaseUrl: 'https://boat.test/api/v1' };

// One fake API per provider so every contract test starts clean.
const providerWith = (key: string) => {
  const api = createBoatApiFake();
  return Object.assign(createBoatProvider(key, BASE, api.fetch), { api });
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
        threadId: 't1',
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
        threadId: 't1',
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
        threadId: 't1',
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
});
