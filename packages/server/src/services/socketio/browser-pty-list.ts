import { BROWSER_PTY_LIST_EVENT, type PtyListResponse } from '@funny/shared/socket-events';
import type { Socket } from 'socket.io';

import {
  authorizedRunnerTerminal,
  runnerAccess,
  runnerActor,
  type RunnerAccess,
} from '../runner-access/index.js';
import type { RunnerPresencePort, RunnerTerminalPort } from '../runner-ports.js';
import { isRateLimited } from '../socketio-rate-limit.js';
import { registerSocketRpc } from './router.js';

/**
 * Ack-based RPC for `pty:list`. Sessions are listed from one of the caller's
 * own general runners, certified by `withRunnerFor`.
 */
export function setupBrowserPtyListRpc(
  socket: Socket,
  userId: string,
  dependencies: {
    terminals?: RunnerTerminalPort;
    presence?: RunnerPresencePort;
    runnerAccess?: RunnerAccess;
  },
): void {
  const access = dependencies.runnerAccess ?? runnerAccess;
  registerSocketRpc<PtyListResponse>(socket, BROWSER_PTY_LIST_EVENT, {
    handler: async (_ctx, ack) => {
      if (isRateLimited(socket.id)) {
        ack({ status: 'error', sessions: [], error: 'rate-limited' });
        return;
      }

      try {
        const terminal = authorizedRunnerTerminal(dependencies.terminals);
        const listed = await access.withRunnerFor(
          runnerActor({ userId }),
          { kind: 'projectless' },
          dependencies.presence,
          async (actor, runner, proof) =>
            terminal.isAvailable(runner) ? terminal.listSessions(actor, runner, proof) : null,
        );
        if (listed.isErr()) {
          ack({ status: 'no-runner', sessions: [] });
          return;
        }
        if (listed.value === null) {
          ack({ status: 'no-runner', sessions: [] });
          return;
        }
        ack({ status: 'ok', sessions: listed.value as any });
      } catch (err) {
        ack({ status: 'error', sessions: [], error: (err as Error).message });
      }
    },
  });
}
