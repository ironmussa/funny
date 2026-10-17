/**
 * @domain subdomain: Team Collaboration
 * @domain subdomain-type: supporting
 * @domain type: handler
 * @domain layer: application
 *
 * Handles data persistence messages from runners.
 * When a runner sends data:insert_message, data:insert_tool_call, etc.,
 * this handler persists the data to the central server's DB and sends
 * back the response (with generated IDs for inserts).
 */

import { repos } from '../db/repos.js';
import { audit } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import { relayToThreadStream, relayToUser } from './browser-events.js';
import { executeDataMessage } from './data-message-handlers.js';
import { assertDataOwnership } from './data-ownership.js';
import { assertRunnerDataScope, filterDataResponse } from './data-scope.js';

/**
 * A disconnected runner loses every in-memory ACP continuation. Expire those
 * durable records before reporting the runner offline so an old card can
 * never be submitted after reconnect.
 */
export async function expirePendingPermissionRequestsForRunner(
  runnerId: string,
): Promise<Array<{ requestId: string; threadId: string; userId: string }>> {
  const expired = await repos.pendingPermissions().expireForRunner(runnerId);
  for (const request of expired) {
    await repos.threads().updateThread(request.threadId, {
      status: 'waiting',
      contextRecoveryReason: 'permission-request-expired',
    });
    const event = {
      type: 'agent:status',
      threadId: request.threadId,
      data: {
        status: 'waiting',
        waitingReason: 'provider_error',
        permissionRecoveryReason: 'runner_lost',
        permissionApprovalCapability: {
          kind: 'unavailable',
          reason: 'codex-sdk-no-interactive-approval',
        },
      },
    };
    relayToUser(request.userId, event);
    relayToThreadStream(request.threadId, event);
  }
  return expired;
}

/**
 * Handle a data persistence message from an authenticated runner request.
 * Returns the serializable response data to the active gRPC operation.
 *
 * `runnerUserId` is the DB-recorded owner of the runner; it is used to reject
 * any request that references entities belonging to a different user.
 */
export async function handleDataMessageWithAck(
  runnerId: string,
  runnerUserId: string | null,
  data: any,
): Promise<any> {
  try {
    const ownership = await assertDataOwnership(runnerUserId, data);
    if (!ownership.ok) {
      log.warn('Rejected cross-tenant data request from runner', {
        namespace: 'data-handler',
        runnerId,
        runnerUserId,
        type: data?.type,
        reason: ownership.reason,
      });
      audit({
        action: 'authz.cross_tenant_refused',
        actorId: runnerUserId,
        detail: `runner data request refused: ${data?.type}`,
        meta: {
          source: 'data-handler',
          runnerId,
          type: data?.type,
          reason: ownership.reason,
        },
      });
      return { type: 'data:ack', success: false, error: 'Forbidden' };
    }

    // Project scope (project-runner-binding): a runner may only touch the
    // projects it is bound to, even within its own user's data.
    const scope = await assertRunnerDataScope(runnerId, data);
    if (!scope.ok) {
      log.warn('Rejected out-of-scope data request from runner', {
        namespace: 'data-handler',
        runnerId,
        runnerUserId,
        type: data?.type,
        reason: scope.reason,
      });
      audit({
        action: 'runner.scope_denied',
        actorId: runnerUserId,
        detail: `runner data request outside project scope: ${data?.type}`,
        meta: {
          source: 'data-handler',
          runnerId,
          type: data?.type,
          reason: scope.reason,
        },
      });
      return { type: 'data:ack', success: false, error: 'Forbidden' };
    }

    const response = await executeDataMessage(runnerId, runnerUserId, data);
    return await filterDataResponse(runnerId, data.type, response);
  } catch (err) {
    log.error('Failed to handle data message from runner', {
      namespace: 'data-handler',
      runnerId,
      type: data?.type,
      error: (err as Error).message,
    });
    return { type: 'data:ack', success: false, error: (err as Error).message };
  }
}
