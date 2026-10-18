import { deriveRunnerForwardingKey } from '@funny/shared/auth/runner-keys';
import { describe, expect, test, vi } from 'vitest';

import type { RunnerCredentials } from '../../services/runner-credentials.js';
import {
  RunnerEnrollmentClient,
  type RunnerEnrollmentClientDependencies,
} from '../../services/runner-enrollment-client.js';

const advertisement = async () => ({
  name: 'test-runner',
  hostname: 'test-host',
  os: 'linux',
  providers: [],
  activeBuiltins: [],
  availableProviders: [],
});

function dependencies(
  fetchImpl: RunnerEnrollmentClientDependencies['fetch'],
): RunnerEnrollmentClientDependencies & {
  saved: RunnerCredentials[];
} {
  const saved: RunnerCredentials[] = [];
  return {
    saved,
    fetch: fetchImpl,
    enroll: vi.fn(async () => ({
      runnerId: 'runner-enrolled',
      token: 'token-enrolled',
      forwardingKey: 'enrolled-key',
      ownerUserId: 'owner-1',
    })),
    loadCredentials: vi.fn(() => null),
    saveCredentials: (value) => saved.push(value),
    clearCredentials: vi.fn(),
    sleep: vi.fn(async () => {}),
    env: { RUNNER_AUTH_SECRET: 'shared-secret' },
  };
}

describe('RunnerEnrollmentClient', () => {
  test('registers, verifies heartbeat, and persists the bearer session', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/register')
        ? Response.json({ runnerId: 'runner-1', token: 'token-1' })
        : Response.json({ ok: true }),
    );
    const deps = dependencies(fetch);
    const client = new RunnerEnrollmentClient('http://server.test', advertisement, deps);

    await expect(client.bootstrap()).resolves.toEqual({
      runnerId: 'runner-1',
      token: 'token-1',
      // Operator-provisioned: derived locally from the root secret.
      forwardingKey: deriveRunnerForwardingKey('shared-secret', 'runner-1'),
      ownerUserId: null,
    });
    expect(deps.saved).toContainEqual({
      serverUrl: 'http://server.test',
      runnerId: 'runner-1',
      token: 'token-1',
    });
  });

  test('uses the server-delivered key + owner from the registration response', async () => {
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith('/register')
        ? Response.json({
            runnerId: 'runner-1',
            token: 'token-1',
            forwardingKey: 'server-derived-key',
            ownerUserId: 'owner-1',
          })
        : Response.json({ ok: true }),
    );
    const deps = dependencies(fetch);
    deps.env = { RUNNER_INVITE_TOKEN: 'invite' };
    const client = new RunnerEnrollmentClient('http://server.test', advertisement, deps);

    const session = await client.bootstrap();
    expect(session.forwardingKey).toBe('server-derived-key');
    expect(session.ownerUserId).toBe('owner-1');
    expect(deps.saved).toContainEqual(
      expect.objectContaining({ forwardingKey: 'server-derived-key', ownerUserId: 'owner-1' }),
    );
    // Security M8: nothing secret is written into the env children inherit.
    expect(deps.env).toEqual({ RUNNER_INVITE_TOKEN: 'invite' });
  });

  test('migrates legacy stored root secret to a per-runner key and drops it from disk', async () => {
    const deps = dependencies(async () => Response.json({ ok: true }));
    deps.env = {};
    deps.loadCredentials = vi.fn(() => ({
      serverUrl: 'http://server.test',
      runnerId: 'runner-legacy',
      token: 'token-legacy',
      forwardedSecret: 'old-root-secret',
    }));
    const client = new RunnerEnrollmentClient('http://server.test', advertisement, deps);

    const session = await client.bootstrap();
    const expected = deriveRunnerForwardingKey('old-root-secret', 'runner-legacy');
    expect(session.forwardingKey).toBe(expected);
    expect(session.ownerUserId).toBeNull();
    expect(deps.saved).toHaveLength(1);
    expect(deps.saved[0]).toEqual({
      serverUrl: 'http://server.test',
      runnerId: 'runner-legacy',
      token: 'token-legacy',
      forwardingKey: expected,
    });
    expect(JSON.stringify(deps.saved)).not.toContain('old-root-secret');
    expect(deps.env).toEqual({});
  });

  test('falls back to device-link enrollment after rejected credentials', async () => {
    let persisted: RunnerCredentials | null = null;
    const deps = dependencies(async (input) => {
      if (String(input).endsWith('/register')) return new Response('unauthorized', { status: 401 });
      return Response.json({ ok: true });
    });
    deps.loadCredentials = vi.fn(() => persisted as any);
    deps.saveCredentials = (value) => {
      persisted = value;
      deps.saved.push(value);
    };
    const client = new RunnerEnrollmentClient('http://server.test', advertisement, deps);

    await expect(client.bootstrap()).resolves.toEqual({
      runnerId: 'runner-enrolled',
      token: 'token-enrolled',
      // The delivered key wins over one derived from the (rejected) env secret.
      forwardingKey: 'enrolled-key',
      ownerUserId: 'owner-1',
    });
    expect(deps.clearCredentials).toHaveBeenCalledOnce();
    expect(deps.sleep).not.toHaveBeenCalled();
    // Security M8: the delivered key is never written into process.env.
    expect(deps.env.RUNNER_AUTH_SECRET).toBe('shared-secret');
  });

  test('keeps a successful registration when heartbeat verification is temporarily unavailable', async () => {
    const deps = dependencies(async (input) => {
      if (String(input).endsWith('/register')) {
        return Response.json({ runnerId: 'runner-1', token: 'token-1' });
      }
      throw new Error('server restarting');
    });
    const client = new RunnerEnrollmentClient('http://server.test', advertisement, deps);

    await expect(client.bootstrap()).resolves.toMatchObject({
      runnerId: 'runner-1',
      token: 'token-1',
    });
  });

  test('retries failed registration with linear backoff capped at 15s', async () => {
    let registerCalls = 0;
    const deps = dependencies(async (input) => {
      if (String(input).endsWith('/register')) {
        registerCalls++;
        return registerCalls < 4
          ? new Response('unavailable', { status: 503 })
          : Response.json({ runnerId: 'runner-1', token: 'token-1' });
      }
      return Response.json({ ok: true });
    });
    const client = new RunnerEnrollmentClient('http://server.test', advertisement, deps);

    await expect(client.bootstrap()).resolves.toMatchObject({
      runnerId: 'runner-1',
      token: 'token-1',
    });
    expect(registerCalls).toBe(4);
    expect(vi.mocked(deps.sleep).mock.calls.map(([ms]) => ms)).toEqual([2000, 4000, 6000]);
  });
});
