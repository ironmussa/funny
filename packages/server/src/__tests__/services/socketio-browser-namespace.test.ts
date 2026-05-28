import { afterEach, describe, expect, mock, test } from 'bun:test';

import { setupBrowserNamespace } from '../../services/socketio/browser-namespace.js';
import { bindSocketIOServer, closeSocketIOServer } from '../../services/socketio/state.js';
import { userHasConnectedRunner } from '../../services/ws-relay.js';
import { createMockIo, createMockSocket } from '../helpers/socketio-test-mocks.js';

describe('setupBrowserNamespace', () => {
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
    setupBrowserNamespace();

    let rejected: Error | undefined;
    await authMiddlewares[0]?.(
      { handshake: { headers: { origin: 'https://evil.test' } } },
      (err) => {
        rejected = err;
      },
    );

    expect(rejected?.message).toBe('Origin not allowed');
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
    setupBrowserNamespace();

    const socket = createMockSocket({
      data: { userId: 'user-1' },
      conn: { transport: { name: 'websocket' } },
      join: mock(() => {}),
    } as any);

    connectionHandlers[0]?.(socket);

    // ws-relay resolves asynchronously inside setupBrowserNamespace
    await new Promise((r) => setTimeout(r, 0));

    expect(socket.emitted.some((e) => e.event === 'runner:status')).toBe(true);
    expect(userHasConnectedRunner('user-1')).toBe(false);
  });
});
