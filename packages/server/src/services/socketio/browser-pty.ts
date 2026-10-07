import {
  BROWSER_PTY_FORWARD_EVENTS,
  browserPtyForwardPayloadSchema,
} from '@funny/shared/socket-events';
import type { Socket } from 'socket.io';

import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import {
  authorizedRunnerTerminal,
  runnerAccess,
  runnerActor,
  type RunnerAccess,
  type RunnerTarget,
} from '../runner-access/index.js';
import type {
  RunnerPresencePort,
  RunnerRequestPort,
  RunnerTerminalEvent,
  RunnerTerminalPort,
} from '../runner-ports.js';
import { rateLimitMiddleware } from './middleware.js';
import { registerSocketHandlersWithSchema } from './router.js';

const TERMINAL_EVENTS = new Set<RunnerTerminalEvent['type']>([
  'pty:spawn',
  'pty:write',
  'pty:resize',
  'pty:close',
  'pty:kill',
  'pty:signal',
  'pty:reconnect',
  'pty:restore',
]);

/**
 * Dependencies shared by the browser-socket → runner handlers. Runner
 * selection and certification go through `runnerAccess`
 * (runner-request-isolation); only project ownership is looked up here.
 */
export interface BrowserPtyDependencies {
  terminals?: RunnerTerminalPort;
  requests?: RunnerRequestPort;
  presence?: RunnerPresencePort;
  /** Production: `runnerAccess`. Tests inject fakes. */
  runnerAccess?: RunnerAccess;
  getProjectOwnerId(projectId: string): Promise<string | null>;
}

/**
 * Set up PTY command handlers for a browser socket. Terminal messages are
 * dispatched only to a runner owned by the caller that holds the project
 * checkout (or any of the caller's general runners without a project).
 */
export function setupBrowserPtyHandlers(
  socket: Socket,
  userId: string,
  dependencies: BrowserPtyDependencies,
): void {
  const access = dependencies.runnerAccess ?? runnerAccess;
  registerSocketHandlersWithSchema(socket, {
    events: BROWSER_PTY_FORWARD_EVENTS,
    payloadSchema: browserPtyForwardPayloadSchema,
    middleware: [rateLimitMiddleware()],
    handler: async ({ socket: sock, eventName }, payload) => {
      const projectId = payload.projectId;
      const terminal = authorizedRunnerTerminal(dependencies.terminals);

      const noRunner = () => {
        if (eventName === 'pty:spawn') {
          sock.emit('pty:error', {
            ptyId: payload.id,
            error: 'No runner available to handle terminal request',
          });
        }
      };

      if (projectId) {
        const projectOwnerId = await dependencies.getProjectOwnerId(projectId);
        if (projectOwnerId !== userId) {
          log.warn('Blocked cross-user PTY request', {
            namespace: 'socketio',
            event: eventName,
            userId,
            projectId,
            ownerId: projectOwnerId,
          });
          audit({
            action: 'authz.cross_tenant_refused',
            actorId: userId ?? null,
            detail: 'Browser PTY request refused — project not owned by caller',
            meta: {
              source: 'socketio:browser_pty',
              event: eventName,
              projectId,
              ownerId: projectOwnerId,
            },
          });
          if (eventName === 'pty:spawn') {
            sock.emit('pty:error', { ptyId: payload.id, error: 'Project not found' });
          }
          return;
        }
      }

      try {
        const target: RunnerTarget = projectId
          ? { kind: 'project-checkout', projectId }
          : { kind: 'projectless' };
        const result = await access.withRunnerFor(
          runnerActor({ userId }),
          target,
          dependencies.presence,
          async (actor, runner, proof) => {
            if (
              !terminal.isAvailable(runner) ||
              !TERMINAL_EVENTS.has(eventName as RunnerTerminalEvent['type'])
            ) {
              log.warn('PTY request has no active compatible gRPC terminal stream', {
                namespace: 'socketio',
                event: eventName,
                userId,
                projectId,
                runnerId: runner.value,
              });
              noRunner();
              return;
            }
            try {
              terminal.dispatch(actor, runner, proof, {
                type: eventName,
                data: payload,
              } as RunnerTerminalEvent);
            } catch (error) {
              log.warn('gRPC PTY forward failed', {
                namespace: 'socketio',
                event: eventName,
                userId,
                runnerId: runner.value,
                error: error instanceof Error ? error.message : String(error),
              });
              sock.emit('pty:error', {
                ptyId: payload.id,
                error: error instanceof Error ? error.message : 'Terminal request failed',
              });
            }
          },
        );
        if (result.isErr()) {
          // No runner of the caller serves this target (or a selected runner
          // failed certification, which `runner-access` has already audited).
          log.warn('PTY request: no runner available for caller', {
            namespace: 'socketio',
            event: eventName,
            userId,
            projectId: projectId ?? null,
            reason: result.error.reason,
          });
          noRunner();
        }
      } catch (e) {
        log.error('PTY forward failed', {
          namespace: 'socketio',
          event: eventName,
          userId,
          projectId,
          error: (e as Error).message,
        });
        noRunner();
      }
    },
  });
}
