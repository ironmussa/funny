import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const socketHandlers: Record<string, (...args: unknown[]) => void> = {};
let mockSocket: {
  connected: boolean;
  emit: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  removeAllListeners: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

vi.mock('socket.io-client', () => ({
  io: vi.fn(() => mockSocket),
}));

vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: { onEvent: vi.fn(() => () => {}) },
}));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: { listProjects: vi.fn(async () => []) },
  }),
}));

import {
  assignProjectToRunner,
  flushPendingMessageUpdates,
  getLocalProjects,
  getTeamServerUrl,
  initTeamMode,
  invalidateProjectCache,
  invalidateThreadCache,
  remoteGetThread,
  remoteCreateProject,
  remoteSaveThreadEvent,
  remoteUpdateMessage,
  shutdownTeamMode,
} from '../../services/team-client.js';

function installSocket() {
  mockSocket = {
    connected: true,
    io: { on: vi.fn() },
    emit: vi.fn((event: string, payload: Record<string, unknown>) => {
      if (typeof event === 'string' && event.startsWith('data:') && payload._requestId) {
        const requestId = payload._requestId as string;
        const response =
          event === 'data:get_thread'
            ? {
                type: 'data:get_thread_response',
                thread: { id: payload.threadId, title: 'Cached' },
              }
            : event === 'data:create_project'
              ? {
                  type: 'data:create_project_response',
                  project: {
                    id: 'created-project',
                    name: payload.name,
                    path: payload.path,
                    userId: payload.userId,
                    createdAt: '2026-06-21T00:00:00.000Z',
                  },
                }
              : { type: 'data:ack', success: true };
        queueMicrotask(() => {
          socketHandlers['data:response']?.({ requestId, response });
        });
      }
      if (event === 'data:update_message') {
        // fire-and-forget — no response expected
      }
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      socketHandlers[event] = handler;
    }),
    once: vi.fn((event: string, handler: () => void) => {
      if (event === 'connect') queueMicrotask(handler);
    }),
    removeAllListeners: vi.fn(),
    disconnect: vi.fn(),
  } as any;
}

describe('team-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    socketHandlers['data:response'] = undefined as unknown as (...args: unknown[]) => void;
    installSocket();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith('/api/runners/register')) {
          return Response.json({ runnerId: 'runner-test', token: 'tok-test' });
        }
        if (url.endsWith('/api/runners/heartbeat')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.includes('/projects')) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response('not found', { status: 404 });
      }),
    );
    process.env.RUNNER_AUTH_SECRET = 'test-secret';
  });

  afterEach(() => {
    shutdownTeamMode();
    vi.unstubAllGlobals();
  });

  test('getLocalProjects is null before assignment warmup', () => {
    expect(getLocalProjects()).toBeNull();
  });

  test('assignProjectToRunner is a no-op without runner registration', async () => {
    await expect(
      assignProjectToRunner({
        id: 'p1',
        name: 'Proj',
        path: '/tmp',
        userId: 'u1',
        createdAt: new Date().toISOString(),
      } as any),
    ).resolves.toBeUndefined();
  });

  test('remoteCreateProject immediately assigns the new project to this runner', async () => {
    await initTeamMode('http://127.0.0.1:3001');

    const response = await remoteCreateProject('Created', '/tmp/created', 'user-1');

    expect(response.project).toMatchObject({ id: 'created-project', path: '/tmp/created' });
    expect(fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:3001/api/runners/runner-test/projects',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          projectId: 'created-project',
          localPath: '/tmp/created',
        }),
      }),
    );
    expect(getLocalProjects()).toEqual([
      expect.objectContaining({ id: 'created-project', path: '/tmp/created' }),
    ]);
  });

  test('remoteSaveThreadEvent waits for server persistence ack', async () => {
    await initTeamMode('http://127.0.0.1:3001');

    await expect(remoteSaveThreadEvent('t1', 'evt', { x: 1 })).resolves.toBeUndefined();

    expect(mockSocket.emit).toHaveBeenCalledWith(
      'data:save_thread_event',
      expect.objectContaining({
        payload: { threadId: 't1', eventType: 'evt', data: { x: 1 } },
        _requestId: expect.any(String),
      }),
    );
  });

  test('remoteSaveThreadEvent rejects when socket is disconnected', async () => {
    await expect(remoteSaveThreadEvent('t1', 'evt', { x: 1 })).rejects.toThrow(
      'Socket.IO not initialized',
    );
  });

  test('flushPendingMessageUpdates is safe when queue is empty', () => {
    expect(() => flushPendingMessageUpdates()).not.toThrow();
  });

  test('remoteGetThread deduplicates in-flight requests after initTeamMode', async () => {
    await initTeamMode('http://127.0.0.1:3001');
    expect(getTeamServerUrl()).toBe('http://127.0.0.1:3001');

    const [a, b] = await Promise.all([remoteGetThread('t-cache'), remoteGetThread('t-cache')]);

    expect(a).toEqual({ id: 't-cache', title: 'Cached' });
    expect(b).toEqual(a);
    const dataEmits = mockSocket.emit.mock.calls.filter(([ev]) => String(ev) === 'data:get_thread');
    expect(dataEmits.length).toBe(1);

    invalidateThreadCache('t-cache');
    await remoteGetThread('t-cache');
    const afterInvalidate = mockSocket.emit.mock.calls.filter(
      ([ev]) => String(ev) === 'data:get_thread',
    );
    expect(afterInvalidate.length).toBe(2);
  });

  test('remoteUpdateMessage debounces emits and flush sends latest content', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await initTeamMode('http://127.0.0.1:3001');

    await remoteUpdateMessage('m1', 'Hello');
    await remoteUpdateMessage('m1', 'Hello world');

    expect(mockSocket.emit).not.toHaveBeenCalledWith(
      'data:update_message',
      expect.objectContaining({ payload: { messageId: 'm1', content: 'Hello world' } }),
    );

    await vi.advanceTimersByTimeAsync(110);

    expect(mockSocket.emit).toHaveBeenCalledWith('data:update_message', {
      payload: { messageId: 'm1', content: 'Hello world' },
    });

    flushPendingMessageUpdates();
    vi.useRealTimers();
  });

  test('invalidateProjectCache does not throw', () => {
    expect(() => invalidateProjectCache('p1')).not.toThrow();
  });
});
