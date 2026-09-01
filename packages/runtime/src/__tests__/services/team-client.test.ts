import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const h = vi.hoisted(() => ({
  request: vi.fn(async (eventType: string, payload: Record<string, any>) => {
    if (eventType === 'data:get_thread') {
      return {
        type: 'data:get_thread_response',
        thread: { id: payload.threadId, title: 'Cached' },
      };
    }
    if (eventType === 'data:create_project') {
      return {
        type: 'data:create_project_response',
        project: {
          id: 'created-project',
          name: payload.name,
          path: payload.path,
          userId: payload.userId,
          createdAt: '2026-06-21T00:00:00.000Z',
        },
      };
    }
    if (eventType === 'data:get_builtin_providers') return null;
    return { type: 'data:ack', success: true };
  }),
  start: vi.fn(),
  shutdown: vi.fn(),
}));

vi.mock('../../services/grpc-team-transport.js', () => ({
  GrpcTeamTransport: class {
    request = h.request;
    start = h.start;
    shutdown = h.shutdown;
    publish = vi.fn();
  },
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
vi.mock('../../services/runner-credentials.js', () => ({
  clearRunnerCredentials: vi.fn(),
  loadRunnerCredentials: vi.fn(() => null),
  saveRunnerCredentials: vi.fn(),
}));

import {
  invalidateProjectCache,
  remoteCreateProject,
} from '../../services/remote-project-identity-client.js';
import {
  flushPendingMessageUpdates,
  invalidateThreadCache,
  remoteGetThread,
  remoteSaveThreadEvent,
  remoteUpdateMessage,
} from '../../services/remote-thread-data-client.js';
import {
  assignProjectToRunner,
  getLocalProjects,
  getTeamServerUrl,
  initTeamMode,
  shutdownTeamMode,
} from '../../services/team-client.js';

describe('team-client', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.RUNNER_AUTH_SECRET = 'test-secret';
    process.env.RUNNER_GRPC_ENDPOINT = 'grpc.test:50051';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith('/api/runners/register')) {
          return Response.json({ runnerId: 'runner-test', token: 'tok-test' });
        }
        if (url.endsWith('/api/runners/heartbeat')) return Response.json({ ok: true });
        return new Response('not found', { status: 404 });
      }),
    );
  });

  afterEach(() => {
    shutdownTeamMode();
    vi.unstubAllGlobals();
    delete process.env.RUNNER_AUTH_SECRET;
    delete process.env.RUNNER_GRPC_ENDPOINT;
    vi.useRealTimers();
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

  test('remoteCreateProject updates the local cache without HTTP fallback', async () => {
    await initTeamMode('http://127.0.0.1:3001');
    const response = await remoteCreateProject('Created', '/tmp/created', 'user-1');
    expect(response.project).toMatchObject({ id: 'created-project', path: '/tmp/created' });
    expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining('/projects'), expect.anything());
    expect(getLocalProjects()).toEqual([
      expect.objectContaining({ id: 'created-project', path: '/tmp/created' }),
    ]);
  });

  test('remoteSaveThreadEvent waits for the gRPC persistence acknowledgement', async () => {
    await initTeamMode('http://127.0.0.1:3001');
    await expect(remoteSaveThreadEvent('t1', 'evt', { x: 1 })).resolves.toBeUndefined();
    expect(h.request).toHaveBeenCalledWith('data:save_thread_event', {
      payload: { threadId: 't1', eventType: 'evt', data: { x: 1 } },
    });
  });

  test('data operations reject before gRPC initialization', async () => {
    await expect(remoteSaveThreadEvent('t1', 'evt', { x: 1 })).rejects.toThrow(
      'gRPC runner transport not initialized',
    );
  });

  test('remoteGetThread deduplicates in-flight gRPC requests', async () => {
    await initTeamMode('http://127.0.0.1:3001');
    expect(getTeamServerUrl()).toBe('http://127.0.0.1:3001');
    const [a, b] = await Promise.all([remoteGetThread('t-cache'), remoteGetThread('t-cache')]);
    expect(a).toEqual({ id: 't-cache', title: 'Cached' });
    expect(b).toEqual(a);
    expect(h.request.mock.calls.filter(([event]) => event === 'data:get_thread')).toHaveLength(1);
    invalidateThreadCache('t-cache');
    await remoteGetThread('t-cache');
    expect(h.request.mock.calls.filter(([event]) => event === 'data:get_thread')).toHaveLength(2);
  });

  test('remoteUpdateMessage debounces gRPC operations and flushes latest content', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await initTeamMode('http://127.0.0.1:3001');
    await remoteUpdateMessage('m1', 'Hello');
    await remoteUpdateMessage('m1', 'Hello world');
    expect(h.request).not.toHaveBeenCalledWith('data:update_message', expect.anything());
    await vi.advanceTimersByTimeAsync(110);
    expect(h.request).toHaveBeenCalledWith('data:update_message', {
      payload: { messageId: 'm1', content: 'Hello world' },
    });
    flushPendingMessageUpdates();
  });

  test('invalidateProjectCache does not throw', () => {
    expect(() => invalidateProjectCache('p1')).not.toThrow();
  });
});
