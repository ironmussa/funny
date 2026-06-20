import {
  runnerAssignProjectSchema,
  runnerHeartbeatSchema,
  runnerPollTasksSchema,
} from '@funny/shared/socket-events';
import type { Socket } from 'socket.io';

import { audit } from '../../lib/audit.js';
import { log } from '../../lib/logger.js';
import { registerSocketRpc } from './router.js';

type RunnerHeartbeatRpcResponse =
  | { code: 'RUNNER_NOT_FOUND' }
  | { ok: true; wsConnected: boolean }
  | { error: string; success: false };

type RunnerPollTasksRpcResponse = { tasks: unknown[]; error?: string };

type RunnerAssignProjectRpcResponse = { ok: boolean; error?: string };

/**
 * Runner control handlers (heartbeat, task polling, project assignment).
 */
export function setupRunnerControlHandlers(socket: Socket, runnerId: string): void {
  registerSocketRpc<RunnerHeartbeatRpcResponse, typeof runnerHeartbeatSchema>(
    socket,
    'runner:heartbeat',
    {
      payloadSchema: runnerHeartbeatSchema,
      invalidPayloadResponse: { error: 'Invalid payload', success: false },
      handler: async (_ctx, ack, data) => {
        try {
          const rm = await import('../runner-manager.js');
          const exists = await rm.handleHeartbeat(runnerId, data);
          if (!exists) {
            ack({ code: 'RUNNER_NOT_FOUND' });
          } else {
            const wsRelay = await import('../ws-relay.js');
            ack({ ok: true, wsConnected: wsRelay.isRunnerConnected(runnerId) });
          }
        } catch (err) {
          log.error('Heartbeat handler error', {
            namespace: 'socketio',
            runnerId,
            error: (err as Error).message,
          });
          ack({ error: 'Internal error', success: false });
        }
      },
    },
  );

  registerSocketRpc<RunnerPollTasksRpcResponse, typeof runnerPollTasksSchema>(
    socket,
    'runner:poll_tasks',
    {
      payloadSchema: runnerPollTasksSchema,
      handler: async (_ctx, ack) => {
        try {
          const rm = await import('../runner-manager.js');
          const tasks = await rm.getPendingTasks(runnerId);
          ack({ tasks });
        } catch (err) {
          log.error('Poll tasks handler error', {
            namespace: 'socketio',
            runnerId,
            error: (err as Error).message,
          });
          ack({ tasks: [], error: 'Internal error' });
        }
      },
    },
  );

  registerSocketRpc<RunnerAssignProjectRpcResponse, typeof runnerAssignProjectSchema>(
    socket,
    'runner:assign_project',
    {
      payloadSchema: runnerAssignProjectSchema,
      invalidPayloadResponse: { ok: false, error: 'Invalid payload' },
      handler: async (_ctx, ack, data) => {
        try {
          const payload = data;
          if (payload.projectId && payload.localPath) {
            const runnerUserId = (socket.data?.runnerUserId ?? null) as string | null;
            if (!runnerUserId) {
              audit({
                action: 'authz.cross_tenant_refused',
                actorId: null,
                detail: 'runner assign_project refused — runner has no owner',
                meta: {
                  source: 'socketio:runner_assign_project',
                  runnerId,
                  projectId: payload.projectId,
                },
              });
              ack({ ok: false, error: 'Forbidden' });
              return;
            }
            const projectRepo = await import('../project-repository.js');
            const access = await projectRepo.resolveProjectPath(payload.projectId, runnerUserId);
            if (access.isErr()) {
              log.warn('Runner attempted cross-tenant project assignment', {
                namespace: 'socketio',
                runnerId,
                runnerUserId,
                projectId: payload.projectId,
                reason: access.error.message,
              });
              audit({
                action: 'authz.cross_tenant_refused',
                actorId: runnerUserId,
                detail: 'runner assign_project refused',
                meta: {
                  source: 'socketio:runner_assign_project',
                  runnerId,
                  projectId: payload.projectId,
                },
              });
              ack({ ok: false, error: 'Forbidden' });
              return;
            }
            const rm = await import('../runner-manager.js');
            await rm.assignProject(runnerId, {
              projectId: payload.projectId,
              localPath: payload.localPath,
            });
          }
          ack({ ok: true });
        } catch (err) {
          log.error('Assign project handler error', {
            namespace: 'socketio',
            runnerId,
            error: (err as Error).message,
          });
          ack({ ok: false, error: 'Internal error' });
        }
      },
    },
  );
}
