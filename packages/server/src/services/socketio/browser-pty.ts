import {
  BROWSER_PTY_FORWARD_EVENTS,
  browserPtyForwardPayloadSchema,
} from '@funny/shared/socket-events';
import type { Socket } from 'socket.io';

import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import { rateLimitMiddleware } from './middleware.js';
import { registerSocketHandlersWithSchema } from './router.js';
import { getIO } from './state.js';

/**
 * Set up PTY command handlers for a browser socket.
 * Forwards PTY commands to the appropriate runner.
 */
export function setupBrowserPtyHandlers(socket: Socket, userId: string): void {
  registerSocketHandlersWithSchema(socket, {
    events: BROWSER_PTY_FORWARD_EVENTS,
    payloadSchema: browserPtyForwardPayloadSchema,
    middleware: [rateLimitMiddleware()],
    handler: async ({ socket: sock, eventName }, payload) => {
      const projectId = payload.projectId;

      const forwardToRunner = async (runnerId: string | null) => {
        if (runnerId) {
          const wsRelay = await import('../ws-relay.js');
          const socketId = wsRelay.getRunnerSocketId(runnerId);
          if (socketId) {
            getIO()
              .of('/runner')
              .to(socketId)
              .emit('central:browser_ws', {
                userId,
                data: { type: eventName, data: payload },
              });
          } else if (eventName === 'pty:spawn') {
            // Runner resolved but its socket isn't registered (just dropped /
            // reconnecting). Log so this stops being a silent failure.
            log.warn('PTY spawn: resolved runner has no live socket', {
              namespace: 'socketio',
              userId,
              projectId,
              runnerId,
            });
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

      const rm = await import('../runner-manager.js');

      if (projectId) {
        try {
          const projectRepo = await import('../project-repository.js');
          const project = await projectRepo.getProject(projectId);
          if (!project || project.userId !== userId) {
            log.warn('Blocked cross-user PTY request', {
              namespace: 'socketio',
              event: eventName,
              userId,
              projectId,
              ownerId: project?.userId ?? null,
            });
            audit({
              action: 'authz.cross_tenant_refused',
              actorId: userId ?? null,
              detail: 'Browser PTY request refused — project not owned by caller',
              meta: {
                source: 'socketio:browser_pty',
                event: eventName,
                projectId,
                ownerId: project?.userId ?? null,
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
          const result = await rm.findRunnerForProject(projectId, userId);
          const runnerId = result?.runner.runnerId ?? null;
          if (runnerId) {
            const runnerUserId = await rm.getRunnerUserId(runnerId);
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
        const runnerId = await rm.findAnyRunnerForUser(userId);
        await forwardToRunner(runnerId);
      }
    },
  });
}
