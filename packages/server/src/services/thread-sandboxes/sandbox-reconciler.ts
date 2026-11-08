/**
 * Brings sandbox rows back in line with reality (change thread-sandboxes).
 * Every operation cleans up after itself while the server runs; this covers
 * what an operation cannot: the process dying mid-operation (a deploy during
 * a setup), and cleanups that failed because the provider was down.
 *
 *   - in-flight state left by an earlier process, or stale for too long:
 *     a stop or a wake is finished keeping the disk (`recover`); a setup is
 *     failed and its machine freed (`abandon`);
 *   - failed / lost sandbox still holding a machine → free it (`release`);
 *   - row of a deleted thread (its destroy failed) → `destroy` again.
 *
 * Runs at startup and on every lifecycle tick; a failed action is simply
 * retried on the next pass.
 */

import { eq } from 'drizzle-orm';
import { Effect, Exit } from 'effect';
import { ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { threadSandboxes, threads } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';
import { fromResult } from './effect-bridge.js';
import { exitFailure, type ThreadSandboxControl } from './thread-sandbox-control.js';
import type { ProvisionError } from './thread-sandbox-service.js';

/** States owned by a running operation: orphaned when that operation is gone. */
const IN_FLIGHT_STATES = new Set([
  'provisioning',
  'installing',
  'connecting',
  'bootstrapping',
  'stopping',
]);
const DEAD_STATES = new Set(['failed', 'lost']);

/** Longer than any live operation takes (install ≤ 10 min, connect ≤ 3 min, …). */
export const STALE_IN_FLIGHT_MS = 30 * 60_000;
/** A row younger than this may belong to a thread still being created. */
const ORPHAN_GRACE_MS = 2 * 60_000;

export interface ReconcileCandidate {
  threadId: string;
  state: string;
  sandboxId: string | null;
  /** Set once the sandbox has been running: a `connecting` row with it is a wake. */
  runnerId: string | null;
  /** ISO timestamp of the row's last change. */
  updatedAt: string;
  threadExists: boolean;
}

export type ReconcileAction = 'destroy' | 'abandon' | 'recover' | 'release';

export function reconcileAction(
  candidate: ReconcileCandidate,
  clock: { nowMs: number; bootedAtMs: number },
): ReconcileAction | null {
  const updatedMs = Date.parse(candidate.updatedAt) || 0;
  if (!candidate.threadExists) {
    return clock.nowMs - updatedMs >= ORPHAN_GRACE_MS ? 'destroy' : null;
  }
  if (IN_FLIGHT_STATES.has(candidate.state)) {
    const orphaned = updatedMs < clock.bootedAtMs || clock.nowMs - updatedMs >= STALE_IN_FLIGHT_MS;
    if (!orphaned) return null;
    const stopOrWake =
      candidate.state === 'stopping' || (candidate.state === 'connecting' && !!candidate.runnerId);
    return stopOrWake && candidate.sandboxId ? 'recover' : 'abandon';
  }
  if (DEAD_STATES.has(candidate.state) && candidate.sandboxId) return 'release';
  return null;
}

/** Every sandbox row with whether its thread still exists. */
function listReconcileCandidates(): ResultAsync<ReconcileCandidate[], string> {
  return ResultAsync.fromPromise(
    db
      .select({
        threadId: threadSandboxes.threadId,
        state: threadSandboxes.state,
        sandboxId: threadSandboxes.sandboxId,
        runnerId: threadSandboxes.runnerId,
        updatedAt: threadSandboxes.updatedAt,
        threadRef: threads.id,
      })
      .from(threadSandboxes)
      .leftJoin(threads, eq(threads.id, threadSandboxes.threadId)),
    (error) => (error instanceof Error ? error.message : String(error)),
  ).map((rows) =>
    rows.map(({ threadRef, ...row }) => ({ ...row, threadExists: threadRef !== null })),
  );
}

export interface ReconcileReport {
  /** Actions that succeeded, per kind. */
  done: Record<ReconcileAction, number>;
  failed: number;
}

export function createSandboxReconciler(deps: {
  control: Pick<ThreadSandboxControl, 'destroy' | 'release' | 'abandon' | 'recover'>;
  listCandidates?: () => ResultAsync<ReconcileCandidate[], string>;
  /** When this server process started: in-flight rows older than it are orphans. */
  bootedAtMs: number;
  now?: () => number;
  /** Provider calls in parallel (sandbox plans rate-limit their API). */
  concurrency?: number;
}) {
  const listCandidates = deps.listCandidates ?? listReconcileCandidates;
  const now = deps.now ?? Date.now;

  const run = (action: ReconcileAction, threadId: string): ResultAsync<unknown, ProvisionError> => {
    switch (action) {
      case 'destroy':
        return deps.control.destroy(threadId);
      case 'abandon':
        return deps.control.abandon(
          threadId,
          'sandbox setup interrupted (server restart or stalled operation)',
        );
      case 'recover':
        return deps.control.recover(threadId);
      case 'release':
        return deps.control.release(threadId);
    }
  };

  return {
    /** One pass over every sandbox row. */
    async reconcile(): Promise<ReconcileReport> {
      const report: ReconcileReport = {
        done: { destroy: 0, abandon: 0, recover: 0, release: 0 },
        failed: 0,
      };
      const candidates = await listCandidates();
      if (candidates.isErr()) {
        log.warn('Sandbox reconcile could not list sandboxes', {
          namespace: 'thread-sandboxes',
          error: candidates.error,
        });
        return report;
      }
      const clock = { nowMs: now(), bootedAtMs: deps.bootedAtMs };
      const work = candidates.value.flatMap((candidate) => {
        const action = reconcileAction(candidate, clock);
        return action ? [{ action, threadId: candidate.threadId }] : [];
      });

      await Effect.runPromise(
        Effect.forEach(
          work,
          ({ action, threadId }) =>
            Effect.map(Effect.exit(fromResult(() => run(action, threadId))), (exit) => {
              if (Exit.isSuccess(exit)) {
                report.done[action] += 1;
                metric('thread_sandboxes.reconciled', 1, { attributes: { action } });
                return;
              }
              report.failed += 1;
              log.warn('Sandbox reconcile action failed; retrying next pass', {
                namespace: 'thread-sandboxes',
                threadId,
                action,
                error: exitFailure(exit).message,
              });
            }),
          { concurrency: deps.concurrency ?? 2, discard: true },
        ),
      );
      return report;
    },
  };
}
