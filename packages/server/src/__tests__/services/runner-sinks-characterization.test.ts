/**
 * Characterization of the browser-socket → runner sinks that have no
 * route-level coverage (runner-request-isolation, task 1.2): which runner a
 * message reaches, which identity is signed into it, and when it is refused.
 * The assertions are the contract; the fixture wiring may change with the
 * sinks' dependencies.
 */
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import {
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  __resetForwardedIdentityNonceCacheForTests,
  verifyForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';

import * as auditModule from '../../lib/audit.js';
import { setupBrowserPtyListRpc } from '../../services/socketio/browser-pty-list.js';
import { setupBrowserPtyHandlers } from '../../services/socketio/browser-pty.js';
import { setupBrowserSessionHandlers } from '../../services/socketio/browser-session.js';
import { fakeRunnerAccess } from '../helpers/runner-access-fakes.js';
import { FakeRunnerRequestPort, FakeRunnerTerminalPort } from '../helpers/runner-port-fakes.js';
import { createMockSocket } from '../helpers/socketio-test-mocks.js';

/** Runner ownership and project ownership for the fixture. */
const RUNNER_OWNERS: Record<string, string> = { 'runner-1': 'user-1', 'runner-2': 'user-2' };
const PROJECT_OWNERS: Record<string, string> = { 'p-mine': 'user-1', 'p-theirs': 'user-2' };

interface FixtureOptions {
  /** Runner the project/any-runner lookups return for the caller (null = none). */
  runnerId?: string | null;
  available?: boolean;
}

function fixture(opts: FixtureOptions = {}) {
  const runnerId = opts.runnerId === undefined ? 'runner-1' : opts.runnerId;
  const requests = new FakeRunnerRequestPort();
  const terminals = new FakeRunnerTerminalPort();
  if (runnerId && opts.available !== false) {
    requests.available.add(runnerId);
    terminals.available.add(runnerId);
  }
  terminals.sessions.set('runner-1\0user-1', [{ ptyId: 'pty-a', cwd: '/tmp' }]);
  const dependencies = {
    requests,
    terminals,
    // Selection returns `runnerId` for everyone; certification (ownership)
    // is what keeps another user's runner out.
    runnerAccess: fakeRunnerAccess({ runnerFor: () => runnerId, owners: RUNNER_OWNERS }),
    getProjectOwnerId: async (id: string) => PROJECT_OWNERS[id] ?? null,
  };
  const socket = createMockSocket();
  return { socket, requests, terminals, dependencies };
}

function signedFor(userId: string, headers: Record<string, string>): boolean {
  return verifyForwardedIdentity(
    { userId, role: 'user', orgId: null, orgName: null },
    'test-secret',
    headers[SIGNATURE_HEADER],
    headers[TIMESTAMP_HEADER],
    headers[NONCE_HEADER],
  );
}

let audit: ReturnType<typeof spyOn>;
beforeEach(() => {
  __resetForwardedIdentityNonceCacheForTests();
  audit = spyOn(auditModule, 'audit').mockImplementation(() => {});
});
afterEach(() => mock.restore());

describe('browser-session sink', () => {
  test("forwards the command to the caller's runner, signed for the caller", async () => {
    const f = fixture();
    setupBrowserSessionHandlers(f.socket, 'user-1', f.dependencies);
    await f.socket.trigger('browser-session:navigate', { sessionId: 's1', url: 'https://x.test' });

    expect(f.requests.requests).toHaveLength(1);
    const { runnerId, request } = f.requests.requests[0]!;
    expect(runnerId).toBe('runner-1');
    expect(request).toMatchObject({ method: 'POST', path: '/api/browser-session/command' });
    expect(JSON.parse(request.body as string)).toEqual({
      type: 'browser-session:navigate',
      data: { sessionId: 's1', url: 'https://x.test' },
    });
    expect(request.headers['X-Forwarded-User']).toBe('user-1');
    expect(request.headers['X-Runner-Auth']).toBe('test-secret');
    expect(request.headers['content-type']).toBe('application/json');
    expect(signedFor('user-1', request.headers)).toBe(true);
    expect(signedFor('user-2', request.headers)).toBe(false);
  });

  test('sends nothing when the caller has no runner or the runner is unreachable', async () => {
    const none = fixture({ runnerId: null });
    setupBrowserSessionHandlers(none.socket, 'user-1', none.dependencies);
    await none.socket.trigger('browser-session:navigate', { sessionId: 's1', url: 'https://x' });
    expect(none.requests.requests).toHaveLength(0);

    const offline = fixture({ available: false });
    setupBrowserSessionHandlers(offline.socket, 'user-1', offline.dependencies);
    await offline.socket.trigger('browser-session:navigate', { sessionId: 's1', url: 'https://x' });
    expect(offline.requests.requests).toHaveLength(0);
  });
});

describe('browser PTY sink', () => {
  test("a project terminal is dispatched to the caller's project runner with the caller's id", async () => {
    const f = fixture();
    setupBrowserPtyHandlers(f.socket, 'user-1', f.dependencies);
    await f.socket.trigger('pty:write', { projectId: 'p-mine', id: 'pty-1', data: 'ls\n' });
    expect(f.terminals.events).toEqual([
      {
        runnerId: 'runner-1',
        userId: 'user-1',
        event: { type: 'pty:write', data: { projectId: 'p-mine', id: 'pty-1', data: 'ls\n' } },
      },
    ]);
  });

  test("a terminal without a project goes to one of the caller's own runners", async () => {
    const f = fixture();
    setupBrowserPtyHandlers(f.socket, 'user-1', f.dependencies);
    await f.socket.trigger('pty:spawn', { id: 'pty-1', cwd: '/home' });
    expect(f.terminals.events.map((e) => [e.runnerId, e.userId, e.event.type])).toEqual([
      ['runner-1', 'user-1', 'pty:spawn'],
    ]);
  });

  test('a project owned by someone else is refused, audited, and reported as not found', async () => {
    const f = fixture();
    setupBrowserPtyHandlers(f.socket, 'user-1', f.dependencies);
    await f.socket.trigger('pty:spawn', { projectId: 'p-theirs', id: 'pty-1' });
    expect(f.terminals.events).toHaveLength(0);
    expect(f.socket.emitted).toEqual([
      { event: 'pty:error', data: { ptyId: 'pty-1', error: 'Project not found' } },
    ]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'authz.cross_tenant_refused', actorId: 'user-1' }),
    );
  });

  test('a runner owned by another user is never used, even when the lookup returns it', async () => {
    const f = fixture({ runnerId: 'runner-2' });
    setupBrowserPtyHandlers(f.socket, 'user-1', f.dependencies);
    await f.socket.trigger('pty:spawn', { projectId: 'p-mine', id: 'pty-1' });
    expect(f.terminals.events).toHaveLength(0);
    expect(f.socket.emitted).toEqual([
      {
        event: 'pty:error',
        data: { ptyId: 'pty-1', error: 'No runner available to handle terminal request' },
      },
    ]);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'authz.cross_tenant_refused', actorId: 'user-1' }),
    );
  });

  test('spawn with no runner reports unavailable; other events stay silent', async () => {
    const f = fixture({ runnerId: null });
    setupBrowserPtyHandlers(f.socket, 'user-1', f.dependencies);
    await f.socket.trigger('pty:write', { projectId: 'p-mine', id: 'pty-1', data: 'x' });
    expect(f.socket.emitted).toEqual([]);
    await f.socket.trigger('pty:spawn', { projectId: 'p-mine', id: 'pty-1' });
    expect(f.socket.emitted).toEqual([
      {
        event: 'pty:error',
        data: { ptyId: 'pty-1', error: 'No runner available to handle terminal request' },
      },
    ]);
    expect(f.terminals.events).toHaveLength(0);
  });
});

describe('browser pty:list sink', () => {
  test("lists the caller's sessions on the caller's runner", async () => {
    const f = fixture();
    setupBrowserPtyListRpc(f.socket, 'user-1', f.dependencies);
    let response: unknown;
    await f.socket.triggerRpc('pty:list', {}, (value) => (response = value));
    expect(response).toEqual({ status: 'ok', sessions: [{ ptyId: 'pty-a', cwd: '/tmp' }] });
  });

  test('answers no-runner when the caller has no reachable runner', async () => {
    for (const f of [fixture({ runnerId: null }), fixture({ available: false })]) {
      setupBrowserPtyListRpc(f.socket, 'user-1', f.dependencies);
      let response: unknown;
      await f.socket.triggerRpc('pty:list', {}, (value) => (response = value));
      expect(response).toEqual({ status: 'no-runner', sessions: [] });
    }
  });

  test("another user's runner is never listed", async () => {
    const f = fixture({ runnerId: 'runner-2' });
    setupBrowserPtyListRpc(f.socket, 'user-1', f.dependencies);
    let response: unknown;
    await f.socket.triggerRpc('pty:list', {}, (value) => (response = value));
    expect(response).toEqual({ status: 'no-runner', sessions: [] });
  });
});
