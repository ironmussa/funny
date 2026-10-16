import { waitFor } from '@funny/shared/async';
/**
 * @domain subdomain: Pipeline
 * @domain subdomain-type: core
 * @domain type: store
 * @domain layer: infrastructure
 *
 * In-memory registry of pending approval gates. The pipeline adapter
 * registers a pending approval here, emits a WS event, and awaits the
 * promise; the REST callback (POST /api/pipelines/approvals/:id/respond)
 * resolves it from the other side.
 *
 * Lives in the runtime process. Approvals are not persisted across
 * runner restarts on purpose — a runner crash should fail in-flight
 * approvals rather than leave them dangling.
 */

import { log } from '../lib/logger.js';

export interface ApprovalDecisionPayload {
  decision: 'approve' | 'reject';
  /** On approve: optional comment. On reject: rejection reason. */
  text?: string;
}

interface PendingApproval {
  resolve: (payload: ApprovalDecisionPayload) => void;
  reject: (err: Error) => void;
  /** Subset of the request used for diagnostics + auth checks. */
  meta: {
    threadId: string;
    userId: string;
    gateId: string;
    requestedAt: string;
  };
}

class PipelineApprovalStore {
  private pending = new Map<string, PendingApproval>();

  /**
   * Register a new pending approval. Returns a promise that resolves when
   * `respond()` is called, or rejects on timeout / cancellation.
   */
  register(
    approvalId: string,
    meta: PendingApproval['meta'],
    timeoutMs?: number,
  ): Promise<ApprovalDecisionPayload> {
    return waitFor(
      (resolve, reject) => {
        const entry: PendingApproval = {
          resolve: (payload) => {
            this.cleanup(approvalId);
            resolve(payload);
          },
          reject: (err) => {
            this.cleanup(approvalId);
            reject(err);
          },
          meta,
        };

        this.pending.set(approvalId, entry);
        return () => {
          if (this.pending.get(approvalId) === entry) this.pending.delete(approvalId);
        };
      },
      {
        timeoutMs: timeoutMs && timeoutMs > 0 ? timeoutMs : undefined,
        timeoutError: () => {
          log.warn('Pipeline approval timed out', {
            namespace: 'pipeline-approval-store',
            approvalId,
            gateId: meta.gateId,
            timeoutMs,
          });
          return new Error(`Approval gate "${meta.gateId}" timed out after ${timeoutMs}ms`);
        },
      },
    );
  }

  /**
   * Resolve a pending approval. Returns false if the approval id is not
   * found (already resolved, expired, or never registered).
   *
   * Authorizes by `userId` so a request from another user cannot resolve
   * someone else's gate.
   */
  respond(
    approvalId: string,
    userId: string,
    payload: ApprovalDecisionPayload,
  ): { ok: true } | { ok: false; error: 'not_found' | 'forbidden' } {
    const entry = this.pending.get(approvalId);
    if (!entry) return { ok: false, error: 'not_found' };
    if (entry.meta.userId !== userId) return { ok: false, error: 'forbidden' };
    entry.resolve(payload);
    return { ok: true };
  }

  /** Cancel a pending approval (e.g. pipeline cancelled by user). */
  cancel(approvalId: string, reason = 'cancelled'): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    entry.reject(new Error(reason));
    return true;
  }

  /** Get diagnostic metadata for a pending approval (no resolver/reject fns). */
  peek(approvalId: string): PendingApproval['meta'] | undefined {
    return this.pending.get(approvalId)?.meta;
  }

  /** Snapshot of currently-pending approvals, for debug endpoints. */
  list(): Array<{ approvalId: string } & PendingApproval['meta']> {
    return Array.from(this.pending.entries()).map(([approvalId, entry]) => ({
      approvalId,
      ...entry.meta,
    }));
  }

  private cleanup(approvalId: string): void {
    this.pending.delete(approvalId);
  }
}

/** Singleton instance for the runtime process. */
export const pipelineApprovalStore = new PipelineApprovalStore();
