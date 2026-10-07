import { BROWSER_SESSION_EVENTS, socketObjectPayloadSchema } from '@funny/shared/socket-events';
import type { Socket } from 'socket.io';

import { log } from '../../lib/logger.js';
import {
  authorizedRunnerRequests,
  runnerAccess,
  runnerActor,
  type RunnerAccess,
} from '../runner-access/index.js';
import type { RunnerPresencePort, RunnerRequestPort } from '../runner-ports.js';
import { rateLimitMiddleware } from './middleware.js';
import { registerSocketHandlersWithSchema } from './router.js';

export interface BrowserSessionDependencies {
  requests?: RunnerRequestPort;
  presence?: RunnerPresencePort;
  /** Production: `runnerAccess`. Tests inject fakes. */
  runnerAccess?: RunnerAccess;
}

/**
 * Forward browser-session commands from the browser socket to the user's
 * runner. The runner is one of the user's own general runners, certified by
 * `withRunnerFor`; the sink signs the user's identity itself.
 */
export function setupBrowserSessionHandlers(
  socket: Socket,
  userId: string,
  dependencies: BrowserSessionDependencies,
): void {
  const access = dependencies.runnerAccess ?? runnerAccess;
  registerSocketHandlersWithSchema(socket, {
    events: BROWSER_SESSION_EVENTS,
    payloadSchema: socketObjectPayloadSchema,
    middleware: [rateLimitMiddleware()],
    handler: async ({ eventName }, payload) => {
      const sink = authorizedRunnerRequests(dependencies.requests);
      const noRunner = () =>
        log.warn('No runner for browser-session', {
          namespace: 'socketio',
          event: eventName,
          userId,
        });

      const result = await access.withRunnerFor(
        runnerActor({ userId }),
        { kind: 'projectless' },
        dependencies.presence,
        async (actor, runner, proof) => {
          if (!sink.isAvailable(runner)) {
            noRunner();
            return;
          }
          try {
            await sink.send(actor, runner, proof, {
              method: 'POST',
              path: '/api/browser-session/command',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ type: eventName, data: payload }),
            });
          } catch (error) {
            log.warn('Browser-session gRPC dispatch failed', {
              namespace: 'socketio',
              event: eventName,
              userId,
              runnerId: runner.value,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        },
      );
      if (result.isErr()) noRunner();
    },
  });
}
