import { BROWSER_PTY_LIST_EVENT, type PtyListResponse } from '@funny/shared/socket-events';
import type { Socket } from 'socket.io';

import { log } from '../../lib/logger.js';
import { isRateLimited } from '../socketio-rate-limit.js';
import { registerSocketRpc } from './router.js';
import { getIO } from './state.js';

const PTY_LIST_TIMEOUT_MS = 5_000;

/**
 * Ack-based RPC for `pty:list`.
 */
export function setupBrowserPtyListRpc(socket: Socket, userId: string): void {
  registerSocketRpc<PtyListResponse>(socket, BROWSER_PTY_LIST_EVENT, {
    handler: async (_ctx, ack) => {
      if (isRateLimited(socket.id)) {
        ack({ status: 'error', sessions: [], error: 'rate-limited' });
        return;
      }

      try {
        const rm = await import('../runner-manager.js');
        const runnerId = await rm.findAnyRunnerForUser(userId);
        if (!runnerId) {
          ack({ status: 'no-runner', sessions: [] });
          return;
        }

        const wsRelay = await import('../ws-relay.js');
        const socketId = wsRelay.getRunnerSocketId(runnerId);
        if (!socketId) {
          ack({ status: 'no-runner', sessions: [] });
          return;
        }

        const runnerSocket = getIO().of('/runner').sockets.get(socketId);
        if (!runnerSocket) {
          ack({ status: 'no-runner', sessions: [] });
          return;
        }

        try {
          const response = (await runnerSocket
            .timeout(PTY_LIST_TIMEOUT_MS)
            .emitWithAck('central:pty_list', { userId })) as {
            sessions?: unknown[];
          };
          ack({
            status: 'ok',
            sessions: Array.isArray(response?.sessions) ? response.sessions : [],
          });
        } catch (err) {
          log.warn('pty:list RPC timed out', {
            namespace: 'socketio',
            userId,
            runnerId,
            timeoutMs: PTY_LIST_TIMEOUT_MS,
            error: (err as Error).message,
          });
          ack({ status: 'timeout', sessions: [] });
        }
      } catch (err) {
        log.error('pty:list RPC failed', {
          namespace: 'socketio',
          userId,
          error: (err as Error).message,
        });
        ack({ status: 'error', sessions: [], error: (err as Error).message });
      }
    },
  });
}
