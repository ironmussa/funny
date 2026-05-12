/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: types
 * @domain layer: domain
 *
 * Pure types for the orchestrator core. No DB, no HTTP, no
 * async. The service layer in `packages/server` builds these inputs
 * from the database and consumes the planner's output.
 */

import type { Thread } from '@funny/shared';

/** Snapshot of an in-flight pipeline run as the orchestrator sees it. */
export interface RunRef {
  threadId: string;
  userId: string;
  /** 0 for the first attempt; incremented on each retry. */
  attempt: number;
  /** ms since epoch when the most recent pipeline event arrived. */
  lastEventAtMs: number;
  /** Linked pipeline run (`pipelineRuns.id`) once dispatched. */
  pipelineRunId: string | null;
}

/** A retry that's queued waiting for `nextRetryAtMs <= now`. */
export interface RetryEntry {
  threadId: string;
  userId: string;
  attempt: number;
  nextRetryAtMs: number;
  lastError: string;
}

/** Slot caps that bound how many threads can run concurrently. */
export interface SlotPolicy {
  maxConcurrentGlobal: number;
  maxConcurrentPerUser: number;
}

/** Inputs to `planDispatch`. All fields are deterministic snapshots. */
export interface EligibilityInput {
  /** Threads in eligible stages/statuses, pre-filtered by the SQL query. */
  candidates: Thread[];
  /** Threads currently executing (a row exists in `orchestrator_runs`). */
  running: Map<string, RunRef>;
  /** Threads being claimed in this tick — used to dedupe within a tick. */
  claimed: Set<string>;
  /** Retry-due-or-pending entries, keyed by threadId. */
  retryQueue: Map<string, RetryEntry>;
  /**
   * `threadId → blocking thread IDs`. A candidate is dispatchable only
   * when every blocker is in `terminalThreadIds`.
   */
  dependencies: Map<string, string[]>;
  /** Threads whose stage is `done` or `archived`. */
  terminalThreadIds: Set<string>;
  slots: SlotPolicy;
  /** ms since epoch — passed in so the planner stays pure. */
  now: number;
}

/** Output of the planner. The service applies this verbatim. */
export interface DispatchPlan {
  /** Eligible threads chosen for fresh dispatch this tick. */
  toDispatch: Thread[];
  /** Retry entries whose `nextRetryAtMs <= now` and that fit in a slot. */
  toRetry: RetryEntry[];
  /**
   * Reasons the planner skipped specific threads — useful for debug
   * UI, telemetry, and tests. Order matches input order.
   */
  skipped: SkippedReason[];
}

export interface SkippedReason {
  threadId: string;
  reason:
    | 'already-claimed'
    | 'already-running'
    | 'in-retry-queue'
    | 'blocked-by-dependency'
    | 'global-slots-exhausted'
    | 'user-slots-exhausted';
}

export type OrchestratorErrorCode = 'INVALID_INPUT';

export interface OrchestratorError {
  code: OrchestratorErrorCode;
  message: string;
}
