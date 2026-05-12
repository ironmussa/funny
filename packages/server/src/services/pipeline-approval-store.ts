/**
 * Server-side pipeline approval store.
 *
 * Mirrors the runtime store but lives in the server process so that an
 * orchestrator binary calling server-native endpoints can long-poll on
 * approvals. The `respond` endpoint resolves entries here when present
 * (and falls through to the runner for in-process pipelines).
 */

import { log } from '../lib/logger.js';

export interface ApprovalDecisionPayload {
  decision: 'approve' | 'reject';
  text?: string;
}

interface PendingApproval {
  resolve: (payload: ApprovalDecisionPayload) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
  meta: {
    threadId: string;
    userId: string;
    gateId: string;
    requestedAt: string;
  };
}

class PipelineApprovalStore {
  private pending = new Map<string, PendingApproval>();

  register(
    approvalId: string,
    meta: PendingApproval['meta'],
    timeoutMs?: number,
  ): Promise<ApprovalDecisionPayload> {
    return new Promise((resolve, reject) => {
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

      if (timeoutMs && timeoutMs > 0) {
        entry.timer = setTimeout(() => {
          if (this.pending.has(approvalId)) {
            log.warn('Pipeline approval timed out', {
              namespace: 'pipeline-approval-store',
              approvalId,
              gateId: meta.gateId,
              timeoutMs,
            });
            entry.reject(
              new Error(`Approval gate "${meta.gateId}" timed out after ${timeoutMs}ms`),
            );
          }
        }, timeoutMs);
      }

      this.pending.set(approvalId, entry);
    });
  }

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

  has(approvalId: string): boolean {
    return this.pending.has(approvalId);
  }

  cancel(approvalId: string, reason = 'cancelled'): boolean {
    const entry = this.pending.get(approvalId);
    if (!entry) return false;
    entry.reject(new Error(reason));
    return true;
  }

  list(): Array<{ approvalId: string } & PendingApproval['meta']> {
    return Array.from(this.pending.entries()).map(([approvalId, entry]) => ({
      approvalId,
      ...entry.meta,
    }));
  }

  private cleanup(approvalId: string): void {
    const entry = this.pending.get(approvalId);
    if (entry?.timer) clearTimeout(entry.timer);
    this.pending.delete(approvalId);
  }
}

export const pipelineApprovalStore = new PipelineApprovalStore();
