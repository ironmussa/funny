import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';

import * as runnerManager from '../../services/runner-manager.js';
import * as runnerResolver from '../../services/runner-resolver.js';
import { setupRunnerNamespace } from '../../services/socketio/runner-namespace.js';
import { bindSocketIOServer, closeSocketIOServer } from '../../services/socketio/state.js';
import {
  getRunnerSocketId,
  isRunnerConnected,
  removeRunnerClient,
  setIO as setRelayIO,
  userHasConnectedRunner,
} from '../../services/ws-relay.js';
import { createMockSocket, createRunnerNamespaceTestIo } from '../helpers/socketio-test-mocks.js';

function installRunnerNamespaceHarness() {
  const harness = createRunnerNamespaceTestIo();
  bindSocketIOServer(harness.io as any, {} as any, null, []);
  setRelayIO(harness.io as any);
  setupRunnerNamespace();
  return harness;
}

async function runAuthMiddleware(
  harness: ReturnType<typeof createRunnerNamespaceTestIo>,
  socket: { handshake: { auth?: { token?: string } } },
): Promise<Error | undefined> {
  let rejected: Error | undefined;
  await harness.authMiddlewares[0]?.(socket, (err) => {
    rejected = err;
  });
  return rejected;
}

describe('setupRunnerNamespace', () => {
  beforeEach(() => {
    removeRunnerClient('runner-1');
  });

  afterEach(async () => {
    mock.restore();
    removeRunnerClient('runner-1');
    await closeSocketIOServer();
  });

  test('rejects handshake when runner token is missing', async () => {
    const harness = installRunnerNamespaceHarness();
    const err = await runAuthMiddleware(harness, { handshake: { auth: {} } });
    expect(err?.message).toBe('No runner token');
  });

  test('rejects handshake when runner token is invalid', async () => {
    spyOn(runnerManager, 'authenticateRunner').mockResolvedValue(null);
    const harness = installRunnerNamespaceHarness();
    const err = await runAuthMiddleware(harness, {
      handshake: { auth: { token: 'bad-token' } },
    });
    expect(err?.message).toBe('Invalid runner token');
  });

  test('authenticates runner and attaches tenant context to socket.data', async () => {
    spyOn(runnerManager, 'authenticateRunner').mockResolvedValue('runner-1');
    spyOn(runnerManager, 'getRunnerUserId').mockResolvedValue('user-1');

    const harness = installRunnerNamespaceHarness();
    const socket: any = { handshake: { auth: { token: 'good-token' } }, data: {} };
    const err = await runAuthMiddleware(harness, socket);

    expect(err).toBeUndefined();
    expect(socket.data).toEqual({
      runnerId: 'runner-1',
      runnerUserId: 'user-1',
      type: 'runner',
    });
  });

  test('registers runner, emits online status, and joins runner room on connect', async () => {
    spyOn(runnerManager, 'authenticateRunner').mockResolvedValue('runner-1');
    spyOn(runnerManager, 'getRunnerUserId').mockResolvedValue('user-1');

    const harness = installRunnerNamespaceHarness();
    const socket = createMockSocket({
      id: 'sock-new',
      data: { runnerId: 'runner-1', runnerUserId: 'user-1', type: 'runner' },
      conn: { transport: { name: 'websocket' } },
      join: mock(() => {}),
    } as any);

    await harness.connectionHandlers[0]?.(socket);

    expect(getRunnerSocketId('runner-1')).toBe('sock-new');
    expect(harness.userRoomEmits).toContainEqual({
      room: 'user:user-1',
      event: 'runner:status',
      payload: { status: 'online', runnerId: 'runner-1' },
    });
    expect(socket.join).toHaveBeenCalledWith('runner:runner-1');
  });

  test('evicts stale runner socket when a replacement connects', async () => {
    spyOn(runnerManager, 'authenticateRunner').mockResolvedValue('runner-1');
    spyOn(runnerManager, 'getRunnerUserId').mockResolvedValue('user-1');

    const harness = installRunnerNamespaceHarness();
    const staleDisconnect = mock(() => {});
    harness.runnerSockets.set('sock-old', { disconnect: staleDisconnect });

    const socket = createMockSocket({
      id: 'sock-new',
      data: { runnerId: 'runner-1', runnerUserId: 'user-1', type: 'runner' },
      conn: { transport: { name: 'websocket' } },
      join: mock(() => {}),
    } as any);

    spyOn(await import('../../services/ws-relay.js'), 'addRunnerClient').mockReturnValue(
      'sock-old',
    );

    await harness.connectionHandlers[0]?.(socket);

    expect(staleDisconnect).toHaveBeenCalledWith(true);
  });

  test('disconnect emits offline, evicts resolver cache, and marks runner offline after grace', async () => {
    spyOn(runnerManager, 'authenticateRunner').mockResolvedValue('runner-1');
    spyOn(runnerManager, 'getRunnerUserId').mockResolvedValue('user-1');
    spyOn(runnerResolver, 'evictRunnerFromCache').mockImplementation(() => {});
    spyOn(runnerManager, 'markRunnerOffline').mockResolvedValue(undefined);

    const scheduled: Array<{ delay: number; fn: () => void | Promise<void> }> = [];
    const originalSetTimeout = globalThis.setTimeout.bind(globalThis);
    spyOn(globalThis, 'setTimeout').mockImplementation(((
      fn: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 15_000) {
        scheduled.push({ delay: delay ?? 0, fn: fn as () => void | Promise<void> });
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }
      return originalSetTimeout(fn, delay, ...args);
    }) as typeof setTimeout);

    const harness = installRunnerNamespaceHarness();
    const socket = createMockSocket({
      id: 'sock-live',
      data: { runnerId: 'runner-1', runnerUserId: 'user-1', type: 'runner' },
      conn: { transport: { name: 'websocket' } },
      join: mock(() => {}),
    } as any);

    await harness.connectionHandlers[0]?.(socket);
    harness.userRoomEmits.length = 0;

    const disconnectHandlers = socket.handlers.get('disconnect') ?? [];
    await disconnectHandlers.at(-1)?.('transport close');

    expect(harness.userRoomEmits).toContainEqual({
      room: 'user:user-1',
      event: 'runner:status',
      payload: { status: 'offline', runnerId: 'runner-1' },
    });
    expect(runnerResolver.evictRunnerFromCache).toHaveBeenCalledWith('runner-1');
    expect(userHasConnectedRunner('user-1')).toBe(false);
    expect(isRunnerConnected('runner-1')).toBe(false);

    expect(scheduled).toHaveLength(1);
    await scheduled[0]?.fn();
    expect(runnerManager.markRunnerOffline).toHaveBeenCalledWith('runner-1');
  });
});
