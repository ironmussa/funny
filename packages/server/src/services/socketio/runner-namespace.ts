import type { Socket } from 'socket.io';

import { log } from '../../lib/logger.js';
import { clearSocketRate } from '../socketio-rate-limit.js';
import { setupRunnerControlHandlers } from './runner-control.js';
import { setupRunnerDataHandlers } from './runner-data.js';
import { cleanupRunnerEventState, setupRunnerEventHandlers } from './runner-events.js';
import { getIO } from './state.js';

/** Pending offline timers — cancelled if the runner reconnects quickly. */
const offlineTimers = new Map<string, ReturnType<typeof setTimeout>>();

const AUTH_TIMEOUT_MS = 10_000;
const OFFLINE_GRACE_MS = 15_000;

export function setupRunnerNamespace(): void {
  const io = getIO();
  const runnerNsp = io.of('/runner');

  runnerNsp.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (!token) {
        return next(new Error('No runner token'));
      }

      const rm = await import('../runner-manager.js');
      const timeoutErr = Symbol('auth_timeout');
      const authResult: string | null | typeof timeoutErr = await Promise.race([
        rm.authenticateRunner(token),
        new Promise<typeof timeoutErr>((resolve) =>
          setTimeout(() => resolve(timeoutErr), AUTH_TIMEOUT_MS).unref(),
        ),
      ]);
      if (authResult === timeoutErr) {
        log.warn('Runner auth timed out during WS handshake', {
          namespace: 'socketio',
          timeoutMs: AUTH_TIMEOUT_MS,
        });
        return next(new Error('Authentication timed out'));
      }
      const runnerId = authResult;
      if (!runnerId) {
        return next(new Error('Invalid runner token'));
      }

      const runnerUserId = await rm.getRunnerUserId(runnerId);

      socket.data = {
        runnerId,
        runnerUserId,
        type: 'runner',
      };
      next();
    } catch {
      next(new Error('Runner authentication failed'));
    }
  });

  runnerNsp.on('connection', async (socket: Socket) => {
    const runnerId = socket.data.runnerId as string;
    const runnerUserId = (socket.data.runnerUserId ?? null) as string | null;

    const pendingTimer = offlineTimers.get(runnerId);
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      offlineTimers.delete(runnerId);
    }

    const wsRelay = await import('../ws-relay.js');
    const replacedSocketId = wsRelay.addRunnerClient(runnerId, socket.id, runnerUserId);

    if (replacedSocketId && replacedSocketId !== socket.id) {
      const stale = runnerNsp.sockets.get(replacedSocketId);
      if (stale) {
        log.warn('Evicting stale runner socket — replaced by new connection', {
          namespace: 'socketio',
          runnerId,
          staleSocketId: replacedSocketId,
          newSocketId: socket.id,
        });
        stale.disconnect(true);
      }
    }

    socket.join(`runner:${runnerId}`);

    log.info('Runner connected via Socket.IO', {
      namespace: 'socketio',
      runnerId,
      socketId: socket.id,
      transport: socket.conn.transport.name,
    });

    if (runnerUserId) {
      getIO().of('/').to(`user:${runnerUserId}`).emit('runner:status', {
        status: 'online',
        runnerId,
      });
    }

    setupRunnerEventHandlers({ socket, runnerId, runnerUserId, wsRelay });
    setupRunnerControlHandlers(socket, runnerId);
    setupRunnerDataHandlers(socket, runnerId, runnerUserId);

    socket.on('disconnect', async (reason) => {
      clearSocketRate(socket.id);
      clearSocketRate(`${socket.id}:critical`);
      cleanupRunnerEventState(socket.id);
      log.warn('Runner disconnected from Socket.IO', {
        namespace: 'socketio',
        runnerId,
        socketId: socket.id,
        reason,
      });

      const wasActive = wsRelay.getRunnerSocketId(runnerId) === socket.id;
      wsRelay.removeRunnerClient(runnerId, socket.id);

      if (!wasActive) return;

      if (runnerUserId && !wsRelay.userHasConnectedRunner(runnerUserId)) {
        getIO().of('/').to(`user:${runnerUserId}`).emit('runner:status', {
          status: 'offline',
          runnerId,
        });
      }

      const resolver = await import('../runner-resolver.js');
      resolver.evictRunnerFromCache(runnerId);

      const timer = setTimeout(async () => {
        offlineTimers.delete(runnerId);

        if (wsRelay.isRunnerConnected(runnerId)) return;

        const rm = await import('../runner-manager.js');
        rm.markRunnerOffline(runnerId).catch(() => {});

        try {
          const { expirePendingPermissionRequestsForRunner } = await import('../data-handler.js');
          await expirePendingPermissionRequestsForRunner(runnerId);
        } catch (error) {
          log.error('Failed to expire pending permissions for offline runner', {
            namespace: 'socketio',
            runnerId,
            error: error instanceof Error ? error.message : String(error),
          });
        }

        const resolverInner = await import('../runner-resolver.js');
        resolverInner.evictRunnerFromCache(runnerId);
      }, OFFLINE_GRACE_MS);

      offlineTimers.set(runnerId, timer);
    });
  });
}
