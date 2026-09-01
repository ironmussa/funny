import {
  BROWSER_PTY_FORWARD_EVENTS,
  browserPtyForwardPayloadSchema,
} from '@funny/shared/socket-events';
import type { Socket } from 'socket.io';

import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import type { RunnerTerminalEvent, RunnerTerminalPort } from '../runner-ports.js';
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
 * Set up PTY command handlers for a browser socket.
 * Forwards PTY commands to the appropriate runner.
 */
export interface BrowserPtyDependencies {
  terminals?: RunnerTerminalPort;
  findAnyRunnerForUser(userId: string): Promise<string | null>;
  findRunnerForProject(projectId: string, userId: string): Promise<string | null>;
  getRunnerUserId(runnerId: string): Promise<string | null>;
  getProjectOwnerId(projectId: string): Promise<string | null>;
}

export function setupBrowserPtyHandlers(
  socket: Socket,
  userId: string,
  dependencies: BrowserPtyDependencies,
): void {
  registerSocketHandlersWithSchema(socket, {
    events: BROWSER_PTY_FORWARD_EVENTS,
    payloadSchema: browserPtyForwardPayloadSchema,
    middleware: [rateLimitMiddleware()],
    handler: async ({ socket: sock, eventName }, payload) => {
      const projectId = payload.projectId;

      const forwardToRunner = async (runnerId: string | null) => {
        if (runnerId) {
          if (
            dependencies.terminals?.isAvailable(runnerId) &&
            TERMINAL_EVENTS.has(eventName as RunnerTerminalEvent['type'])
          ) {
            try {
              dependencies.terminals.dispatch(runnerId, userId, {
                type: eventName,
                data: payload,
              } as RunnerTerminalEvent);
            } catch (error) {
              log.warn('gRPC PTY forward failed', {
                namespace: 'socketio',
                event: eventName,
                userId,
                runnerId,
                error: error instanceof Error ? error.message : String(error),
              });
              sock.emit('pty:error', {
                ptyId: payload.id,
                error: error instanceof Error ? error.message : 'Terminal request failed',
              });
            }
            return;
          }
          log.warn('PTY request has no active compatible gRPC terminal stream', {
            namespace: 'socketio',
            event: eventName,
            userId,
            projectId,
            runnerId,
          });
          if (eventName === 'pty:spawn') {
            sock.emit('pty:error', {
              ptyId: payload.id,
              error: 'No runner available to handle terminal request',
            });
          }
        } else if (eventName === 'pty:spawn') {
          // No runner could be resolved for this project. The most common
          // cause is an orphaned project (no runner_project_assignments row);
          // findRunnerForProject now falls back to the user's online runner,
          // so reaching here means the user genuinely has no connected runner.
          log.warn('PTY spawn: no runner available for project', {
            namespace: 'socketio',
            userId,
            projectId: projectId ?? null,
          });
          sock.emit('pty:error', {
            ptyId: payload.id,
            error: 'No runner available to handle terminal request',
          });
        }
      };

      if (projectId) {
        try {
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
              sock.emit('pty:error', {
                ptyId: payload.id,
                error: 'Project not found',
              });
            }
            return;
          }
          // Scope to the caller's own runner (runner isolation) — never pick
          // another user's runner assigned to the same project. The ownership
          // guard below stays as defense-in-depth.
          const runnerId = await dependencies.findRunnerForProject(projectId, userId);
          if (runnerId) {
            const runnerUserId = await dependencies.getRunnerUserId(runnerId);
            if (runnerUserId !== userId) {
              log.warn('Runner for project owned by different user', {
                namespace: 'socketio',
                event: eventName,
                userId,
                projectId,
                runnerId,
                runnerUserId,
              });
              audit({
                action: 'authz.cross_tenant_refused',
                actorId: userId ?? null,
                detail: 'Browser PTY request refused — runner owned by different user',
                meta: {
                  source: 'socketio:browser_pty',
                  event: eventName,
                  projectId,
                  runnerId,
                  runnerUserId,
                },
              });
              if (eventName === 'pty:spawn') {
                sock.emit('pty:error', {
                  ptyId: payload.id,
                  error: 'No runner available to handle terminal request',
                });
              }
              return;
            }
          }
          await forwardToRunner(runnerId);
        } catch (e) {
          log.error('PTY forward failed', {
            namespace: 'socketio',
            event: eventName,
            userId,
            projectId,
            error: (e as Error).message,
          });
          if (eventName === 'pty:spawn') {
            sock.emit('pty:error', {
              ptyId: payload.id,
              error: 'No runner available to handle terminal request',
            });
          }
        }
      } else {
        const runnerId = await dependencies.findAnyRunnerForUser(userId);
        await forwardToRunner(runnerId);
      }
    },
  });
}
