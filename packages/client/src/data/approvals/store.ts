import type {
  WSPipelineApprovalRequestedData,
  WSPipelineApprovalResolvedData,
} from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { errAsync, type ResultAsync } from 'neverthrow';

import { pipelinesApi } from '@/lib/api/pipelines';
import { createClientLogger } from '@/lib/client-logger';

import type { DataLayer } from '../data-layer';
import { createEntityStore, type EntityStore } from '../entities';
import { optimisticWrite } from '../optimistic-write';
import { getDataLayer } from '../runtime';

/**
 * Pending pipeline approvals (human-in-the-loop gates), keyed by approval id.
 * `pipeline:approval_requested` adds one, `pipeline:approval_resolved` removes
 * it. Answering one hides it at once; a refused answer brings it back with
 * the server's error.
 */

const log = createClientLogger('pipeline-approvals');

export interface PendingApproval extends WSPipelineApprovalRequestedData {
  id: string;
  /** Error of the last refused answer, shown in the dialog. */
  submitError?: string;
}

export function getApprovalsData(layer: DataLayer = getDataLayer()): EntityStore<PendingApproval> {
  return layer.own('pipeline-approvals', () => {
    const data = createEntityStore<PendingApproval>(layer, 'pipeline-approvals');
    return {
      value: data,
      dispose: () => void data.collection.cleanup({ dependents: true }).catch(() => undefined),
    };
  });
}

/** Oldest request first (the dialog answers them in order). */
export function compareApprovals(a: PendingApproval, b: PendingApproval): number {
  return a.requestedAt.localeCompare(b.requestedAt);
}

export function applyApprovalRequested(
  event: WSPipelineApprovalRequestedData,
  layer: DataLayer = getDataLayer(),
): void {
  getApprovalsData(layer).upsert([{ ...event, id: event.approvalId }]);
  log.info('pipeline approval requested', {
    approvalId: event.approvalId,
    gateId: event.gateId,
    threadId: event.threadId,
  });
}

export function applyApprovalResolved(
  event: WSPipelineApprovalResolvedData,
  layer: DataLayer = getDataLayer(),
): void {
  getApprovalsData(layer).remove([event.approvalId]);
  log.info('pipeline approval resolved', {
    approvalId: event.approvalId,
    decision: event.decision,
  });
}

/** Approve or reject a pending approval. */
export function respondToApproval(
  approvalId: string,
  decision: 'approve' | 'reject',
  text?: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<unknown, DomainError> {
  const data = getApprovalsData(layer);
  if (!data.collection.has(approvalId)) {
    return errAsync({ type: 'NOT_FOUND', message: `Approval ${approvalId} is not pending` });
  }
  return optimisticWrite({
    entity: 'pipeline-approvals',
    operation: decision,
    apply: () => data.collection.delete(approvalId),
    persist: () => pipelinesApi.respondToApproval(approvalId, { decision, text }),
    // The server echoes pipeline:approval_resolved; removing now keeps it hidden.
    confirm: () => data.remove([approvalId]),
    failureMessageKey: 'errors.approvalRespondFailed',
  }).mapErr((error) => {
    data.patch(approvalId, (row) => ({ ...row, submitError: error.message }));
    return error;
  });
}
