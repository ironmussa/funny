import { BROWSER_PTY_LIST_EVENT, type PtyListResponse } from '@funny/shared/socket-events';
import type { Socket } from 'socket.io';

import type { RunnerTerminalPort } from '../runner-ports.js';
import { isRateLimited } from '../socketio-rate-limit.js';
import { registerSocketRpc } from './router.js';

/**
 * Ack-based RPC for `pty:list`.
 */
export function setupBrowserPtyListRpc(
  socket: Socket,
  userId: string,
  dependencies: {
    terminals?: RunnerTerminalPort;
    findAnyRunnerForUser(userId: string): Promise<string | null>;
  },
): void {
  registerSocketRpc<PtyListResponse>(socket, BROWSER_PTY_LIST_EVENT, {
    handler: async (_ctx, ack) => {
      if (isRateLimited(socket.id)) {
        ack({ status: 'error', sessions: [], error: 'rate-limited' });
        return;
      }

      try {
        const runnerId = await dependencies.findAnyRunnerForUser(userId);
        if (!runnerId) {
          ack({ status: 'no-runner', sessions: [] });
          return;
        }

        if (!dependencies.terminals?.isAvailable(runnerId)) {
          ack({ status: 'no-runner', sessions: [] });
          return;
        }
        ack({
          status: 'ok',
          sessions: dependencies.terminals.listSessions(runnerId, userId) as any,
        });
      } catch (err) {
        ack({ status: 'error', sessions: [], error: (err as Error).message });
      }
    },
  });
}
