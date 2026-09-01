import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { RunnerGrpcSessionRegistry } from '../../services/grpc/session-registry.js';
import { setupBrowserNamespace } from '../../services/socketio/browser-namespace.js';
import { bindSocketIOServer, closeSocketIOServer } from '../../services/socketio/state.js';
import { createMockIo, createMockSocket } from '../helpers/socketio-test-mocks.js';

describe('setupBrowserNamespace', () => {
  let presence: RunnerGrpcSessionRegistry;

  beforeEach(() => {
    presence = new RunnerGrpcSessionRegistry({ heartbeatTimeoutMs: 10_000 });
  });

  const dependencies = () => ({
    presence,
    findAnyRunnerForUser: async () => null,
    findRunnerForProject: async () => null,
    getRunnerUserId: async () => null,
    getProjectOwnerId: async () => null,
  });
  afterEach(async () => {
    await closeSocketIOServer();
  });

  test('rejects upgrades when Origin is not allowlisted', async () => {
    const authMiddlewares: Array<(socket: any, next: (err?: Error) => void) => void> = [];
    const { io } = createMockIo();
    const ioWithClose = Object.assign(io, {
      close: () => {},
      of: () => ({
        use(fn: (socket: any, next: (err?: Error) => void) => void) {
          authMiddlewares.push(fn);
        },
        on: () => {},
      }),
    });

    bindSocketIOServer(ioWithClose as any, {} as any, { api: {} }, ['http://localhost:5173']);
    setupBrowserNamespace(dependencies());

    let rejected: Error | undefined;
    await authMiddlewares[0]?.(
      { handshake: { headers: { origin: 'https://evil.test' } } },
      (err) => {
        rejected = err;
      },
    );

    expect(rejected?.message).toBe('Origin not allowed');
  });

  test('rejects missing and invalid sessions without activating the namespace', async () => {
    const authMiddlewares: Array<(socket: any, next: (err?: Error) => void) => void> = [];
    const { io } = createMockIo();
    const ioWithClose = Object.assign(io, {
      close: () => {},
      of: () => ({
        use(fn: (socket: any, next: (err?: Error) => void) => void) {
          authMiddlewares.push(fn);
        },
        on: () => {},
      }),
    });
    bindSocketIOServer(ioWithClose as any, {} as any, { api: { getSession: async () => null } }, [
      'http://localhost:5173',
    ]);
    setupBrowserNamespace(dependencies());

    const authenticate = authMiddlewares[0]!;
    let missingCookie: Error | undefined;
    await authenticate({ handshake: { headers: { origin: 'http://localhost:5173' } } }, (error) => {
      missingCookie = error;
    });
    let invalidSession: Error | undefined;
    await authenticate(
      {
        handshake: {
          headers: { origin: 'http://localhost:5173', cookie: 'funny.session=expired' },
        },
      },
      (error) => {
        invalidSession = error;
      },
    );

    expect(missingCookie?.message).toBe('No session cookie');
    expect(invalidSession?.message).toBe('Invalid session');
  });

  test('emits runner:status to newly connected browser sockets', async () => {
    const connectionHandlers: Array<(socket: any) => void> = [];
    const { io } = createMockIo();
    const ioWithClose = Object.assign(io, {
      close: () => {},
      of: () => ({
        use: (_fn: unknown) => {},
        on(event: string, fn: (socket: any) => void) {
          if (event === 'connection') connectionHandlers.push(fn);
        },
      }),
    });

    bindSocketIOServer(ioWithClose as any, {} as any, { api: {} }, ['http://localhost:5173']);
    setupBrowserNamespace(dependencies());

    const socket = createMockSocket({
      data: { userId: 'user-1' },
      conn: { transport: { name: 'websocket' } },
      join: mock(() => {}),
    } as any);

    connectionHandlers[0]?.(socket);

    // The connection handler emits readiness asynchronously.
    await new Promise((r) => setTimeout(r, 0));

    expect(socket.emitted.some((e) => e.event === 'runner:status')).toBe(true);
    expect(presence.userHasAvailableRunner('user-1')).toBe(false);
  });
});
