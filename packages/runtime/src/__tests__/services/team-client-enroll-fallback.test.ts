/**
 * Behavioral test for the device-link fallback in the runner connect flow.
 *
 * Scenario: the runner boots with a STALE RUNNER_AUTH_SECRET in the environment
 * (e.g. left over from local dev) and no persisted credentials. The classic
 * registration is rejected with 401; instead of looping on the rejected secret
 * forever, the runner must fall back to device-link enrollment, persist the
 * delivered credentials, load the delivered forwarded-identity secret into the
 * environment, and then resume successfully.
 *
 * This drives initTeamMode end-to-end with a mocked socket, fetch, enrollment
 * client, and credentials store.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

// ── Mocks (hoisted) ────────────────────────────────────────
// All mock fns + state live in a hoisted block so the vi.mock factories (which
// are hoisted to the top of the module) can reference them safely.
const h = vi.hoisted(() => {
  const credStore: { value: null | Record<string, unknown> } = { value: null };
  return {
    credStore,
    enrollRunner: vi.fn(async () => ({
      runnerId: 'r-enrolled',
      token: 'runner_enrolled',
      forwardedSecret: 'delivered-secret',
    })),
    saveRunnerCredentials: vi.fn((c: Record<string, unknown>) => {
      credStore.value = c;
    }),
    loadRunnerCredentials: vi.fn((serverUrl: string) =>
      credStore.value && credStore.value.serverUrl === serverUrl ? credStore.value : null,
    ),
    clearRunnerCredentials: vi.fn(() => {
      credStore.value = null;
    }),
  };
});
// loadRunnerCredentials is referenced via h in the vi.mock factory below.
const { enrollRunner, saveRunnerCredentials, clearRunnerCredentials } = h;

vi.mock('../../services/runner-enrollment.js', () => ({ enrollRunner: h.enrollRunner }));
vi.mock('../../services/runner-credentials.js', () => ({
  saveRunnerCredentials: h.saveRunnerCredentials,
  loadRunnerCredentials: h.loadRunnerCredentials,
  clearRunnerCredentials: h.clearRunnerCredentials,
}));

vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: { onEvent: vi.fn(() => () => {}) },
}));
vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({ projects: { listProjects: vi.fn(async () => []) } }),
}));

let mockSocket: any;
vi.mock('socket.io-client', () => ({ io: vi.fn(() => mockSocket) }));

function installSocket() {
  mockSocket = {
    connected: true,
    io: { on: vi.fn() },
    emit: vi.fn(),
    on: vi.fn(),
    once: vi.fn((event: string, handler: () => void) => {
      if (event === 'connect') queueMicrotask(handler);
    }),
    removeAllListeners: vi.fn(),
    disconnect: vi.fn(),
  };
}

import { initTeamMode, shutdownTeamMode } from '../../services/team-client.js';

describe('team-client device-link fallback on 401', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.credStore.value = null;
    installSocket();
    // Stale secret in env so maybeEnroll skips and we exercise the FALLBACK.
    process.env.RUNNER_AUTH_SECRET = 'stale-secret';
    delete process.env.RUNNER_INVITE_TOKEN;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        // Classic registration is rejected — triggers the device-link fallback.
        if (url.endsWith('/api/runners/register')) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
        }
        // After enrollment persists creds, resumeSession's heartbeat succeeds.
        if (url.endsWith('/api/runners/heartbeat')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }),
    );
  });

  afterEach(() => {
    shutdownTeamMode();
    vi.unstubAllGlobals();
    delete process.env.RUNNER_AUTH_SECRET;
  });

  test('rejected credentials fall back to enrollment and resume', async () => {
    await initTeamMode('http://srv.test');

    // The fallback ran: rejected creds cleared, then device-link enrollment.
    expect(clearRunnerCredentials).toHaveBeenCalled();
    expect(enrollRunner).toHaveBeenCalledTimes(1);

    // Delivered credentials were persisted (incl. the forwarded-identity secret).
    expect(saveRunnerCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        serverUrl: 'http://srv.test',
        runnerId: 'r-enrolled',
        token: 'runner_enrolled',
        forwardedSecret: 'delivered-secret',
      }),
    );

    // The delivered secret replaced the stale one in the environment.
    expect(process.env.RUNNER_AUTH_SECRET).toBe('delivered-secret');
  });
});
