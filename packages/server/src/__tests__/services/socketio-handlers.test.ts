import { afterEach, describe, expect, test } from 'bun:test';

import { setupBrowserPtyListRpc } from '../../services/socketio/browser-pty-list.js';
import { setupBrowserPtyHandlers } from '../../services/socketio/browser-pty.js';
import { setupBrowserSessionHandlers } from '../../services/socketio/browser-session.js';
import { createMockSocket } from '../helpers/socketio-test-mocks.js';

afterEach(() => {
  delete process.env.RUNNER_AUTH_SECRET;
});

function runnerDependencies(overrides: Record<string, unknown> = {}) {
  return {
    findAnyRunnerForUser: async () => 'runner-1',
    findRunnerForProject: async () => 'runner-1',
    getRunnerUserId: async () => 'user-1',
    getProjectOwnerId: async () => 'user-1',
    ...overrides,
  } as any;
}

describe('browser Socket.IO to runner gRPC handlers', () => {
  test('forwards PTY events only through the active gRPC terminal stream', async () => {
    const dispatched: unknown[] = [];
    const dependencies = runnerDependencies({
      terminals: {
        isAvailable: () => true,
        dispatch: (runnerId: string, userId: string, event: unknown) =>
          dispatched.push({ runnerId, userId, event }),
        listSessions: () => [],
      },
    });
    const socket = createMockSocket();
    setupBrowserPtyHandlers(socket, 'user-1', dependencies);

    await socket.trigger('pty:write', { projectId: 'owned', id: 'pty-1', data: 'ls\n' });

    expect(dispatched).toEqual([
      {
        runnerId: 'runner-1',
        userId: 'user-1',
        event: { type: 'pty:write', data: { projectId: 'owned', id: 'pty-1', data: 'ls\n' } },
      },
    ]);
  });

  test('pty:spawn reports unavailable instead of falling back', async () => {
    const dependencies = runnerDependencies({
      terminals: {
        isAvailable: () => false,
        dispatch: () => {},
        listSessions: () => [],
      },
    });
    const socket = createMockSocket();
    setupBrowserPtyHandlers(socket, 'user-1', dependencies);

    await socket.trigger('pty:spawn', { projectId: 'owned', id: 'pty-1' });

    expect(socket.emitted[0]).toEqual({
      event: 'pty:error',
      data: { ptyId: 'pty-1', error: 'No runner available to handle terminal request' },
    });
  });

  test('pty:list reads the gRPC terminal registry', async () => {
    const dependencies = runnerDependencies({
      terminals: {
        isAvailable: () => true,
        dispatch: () => {},
        listSessions: () => [{ ptyId: 'pty-a', cwd: '/tmp' }],
      },
    });
    const socket = createMockSocket();
    setupBrowserPtyListRpc(socket, 'user-1', dependencies);
    let response: unknown;
    await socket.triggerRpc('pty:list', {}, (value) => {
      response = value;
    });

    expect(response).toEqual({ status: 'ok', sessions: [{ ptyId: 'pty-a', cwd: '/tmp' }] });
  });

  test('forwards browser-session commands through the gRPC tunnel', async () => {
    process.env.RUNNER_AUTH_SECRET = 'test-secret';
    const requests: any[] = [];
    const dependencies = runnerDependencies({
      requests: {
        isAvailable: () => true,
        request: async (_runnerId: string, request: unknown) => {
          requests.push(request);
          return { status: 202, headers: {}, body: '' };
        },
      },
    });
    const socket = createMockSocket();
    setupBrowserSessionHandlers(socket, 'user-1', dependencies);

    await socket.trigger('browser-session:navigate', {
      sessionId: 'session-1',
      url: 'https://example.com',
    });

    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: '/api/browser-session/command',
    });
    expect(Buffer.from(requests[0].body).toString()).toBe(
      JSON.stringify({
        type: 'browser-session:navigate',
        data: { sessionId: 'session-1', url: 'https://example.com' },
      }),
    );
  });
});
