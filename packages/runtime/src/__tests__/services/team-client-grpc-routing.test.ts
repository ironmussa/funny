import { afterEach, beforeEach, describe, expect, test, vi } from 'bun:test';

import type { WSEvent } from '@funny/shared';
import { stubGlobal } from '@funny/test-kit';

interface GrpcOptions {
  endpoint?: string;
  onDisconnected?: (error?: Error) => void;
}

const h = (() => {
  const unset = <T>(): T | undefined => undefined;
  return {
    start: vi.fn(),
    shutdown: vi.fn(),
    publish: vi.fn(),
    request: vi.fn(async (eventType: string) =>
      eventType === 'data:get_builtin_providers' ? null : { success: true },
    ),
    grpcOptions: unset<GrpcOptions>(),
    brokerHandler: unset<(event: WSEvent) => void>(),
  };
})();

const originalFetch = globalThis.fetch;

vi.mock('../../services/grpc-team-transport.js', () => ({
  GrpcTeamTransport: class {
    constructor(options: { endpoint?: string; onDisconnected?: (error?: Error) => void }) {
      h.grpcOptions = options;
    }

    start = h.start;
    shutdown = h.shutdown;
    publish = h.publish;
    request = h.request;
  },
}));
vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: {
    onEvent: vi.fn((handler: (event: WSEvent) => void) => {
      h.brokerHandler = handler;
      return () => {
        h.brokerHandler = undefined;
      };
    }),
  },
}));
// Runner-installed provider extensions are loaded from DATA_DIR on connect;
// keep the developer's ~/.funny/extensions out of the test.
const actualDataDir = { ...(await import('../../lib/data-dir.js')) };
vi.mock('../../lib/data-dir.js', () => ({
  ...actualDataDir,
  DATA_DIR: '/nonexistent/funny-team-client-test',
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

import { remoteSaveThreadEvent } from '../../services/remote-thread-data-client.js';
import {
  initTeamMode,
  requireRunnerGrpcEndpoint,
  shutdownTeamMode,
} from '../../services/team-client.js';

describe('team-client gRPC routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.grpcOptions = undefined;
    process.env.RUNNER_AUTH_SECRET = 'test-secret';
    process.env.RUNNER_GRPC_ENDPOINT = 'grpc.example.test:50051';
    stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/runners/register')) {
          return Response.json({ runnerId: 'runner-grpc', token: 'token-grpc' });
        }
        if (String(input).endsWith('/api/runners/heartbeat')) {
          return Response.json({ success: true });
        }
        return new Response('not found', { status: 404 });
      }),
    );
  });

  afterEach(() => {
    shutdownTeamMode();
    globalThis.fetch = originalFetch;
    delete process.env.RUNNER_AUTH_SECRET;
    delete process.env.RUNNER_GRPC_ENDPOINT;
  });

  test('requires a configured non-empty gRPC endpoint', () => {
    expect(() => requireRunnerGrpcEndpoint({})).toThrow('RUNNER_GRPC_ENDPOINT is required');
    expect(() => requireRunnerGrpcEndpoint({ RUNNER_GRPC_ENDPOINT: '  ' })).toThrow(
      'RUNNER_GRPC_ENDPOINT is required',
    );
    expect(requireRunnerGrpcEndpoint({ RUNNER_GRPC_ENDPOINT: 'server:50051' })).toBe(
      'server:50051',
    );
  });

  test('activates only gRPC and routes data and broker events through it', async () => {
    await initTeamMode('http://central.test');

    expect(h.start).toHaveBeenCalledTimes(1);

    await remoteSaveThreadEvent('thread-1', 'agent:state', { active: true });
    expect(h.request).toHaveBeenCalledWith('data:save_thread_event', {
      payload: { threadId: 'thread-1', eventType: 'agent:state', data: { active: true } },
    });

    const event: WSEvent = { type: 'agent:result', threadId: 'thread-1', data: { result: 'done' } };
    h.brokerHandler?.(event);
    expect(h.publish).toHaveBeenCalledWith(event);
  });

  test('keeps gRPC active when its disconnect callback reports an error', async () => {
    await initTeamMode('http://central.test');

    h.grpcOptions?.onDisconnected?.(new Error('temporary transport failure'));

    expect(h.shutdown).not.toHaveBeenCalled();
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  test('uses the WebSocket carrier on the server origin when no gRPC endpoint is set', async () => {
    delete process.env.RUNNER_GRPC_ENDPOINT;

    await initTeamMode('https://central.test');

    expect(h.grpcOptions?.endpoint).toBe('wss://central.test/api/runner-grpc/ws');
    expect(h.start).toHaveBeenCalledTimes(1);
  });

  test('prefers the explicit private gRPC endpoint', async () => {
    await initTeamMode('https://central.test');

    expect(h.grpcOptions?.endpoint).toBe('grpc.example.test:50051');
  });
});
