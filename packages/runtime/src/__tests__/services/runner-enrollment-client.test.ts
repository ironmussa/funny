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
      forwardedSecret: 'forwarded-secret',
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

    await expect(client.bootstrap()).resolves.toEqual({ runnerId: 'runner-1', token: 'token-1' });
    expect(deps.saved).toContainEqual({
      serverUrl: 'http://server.test',
      runnerId: 'runner-1',
      token: 'token-1',
    });
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
    });
    expect(deps.clearCredentials).toHaveBeenCalledOnce();
    expect(deps.env.RUNNER_AUTH_SECRET).toBe('forwarded-secret');
  });

  test('keeps a successful registration when heartbeat verification is temporarily unavailable', async () => {
    const deps = dependencies(async (input) => {
      if (String(input).endsWith('/register')) {
        return Response.json({ runnerId: 'runner-1', token: 'token-1' });
      }
      throw new Error('server restarting');
    });
    const client = new RunnerEnrollmentClient('http://server.test', advertisement, deps);

    await expect(client.bootstrap()).resolves.toEqual({ runnerId: 'runner-1', token: 'token-1' });
  });
});
