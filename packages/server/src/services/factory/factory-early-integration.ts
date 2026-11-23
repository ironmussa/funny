/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: application
 *
 * Early integration (openspec factory-integration D8): when a change merges
 * into the base and a run's pull request no longer merges, the server runs
 * `integrate` on it then, outside the flow, so its implementer gets any
 * remaining conflict while it still has the context, not at merge time.
 *
 * `integrate` and an agent never touch the run's checkout at once: every step
 * that works in it holds the run's workspace lock (`createWorkspaceLock`).
 * Asked while a step holds it, the integration is pending
 * (`integration_pending_at`) and runs when that step releases the lock,
 * before the next step starts. Inside `ci` or `review` no step holds it, so it
 * runs at once (`wait_ci` follows the new head; the review's freshness rule
 * decides whether its verdict still holds). A run waiting for or holding the
 * merge slot is left to the queue.
 */

import type { ActionResult } from '@funny/workflows/compiler';

/** One run's checkout, held by one step at a time. */
export interface WorkspaceLock {
  /** Run `fn` holding the lock; `after` runs still holding it, once `fn` ends. */
  hold<T>(fn: () => Promise<T>, after?: () => Promise<void>): Promise<T>;
  busy(): boolean;
}

export function createWorkspaceLock(): WorkspaceLock {
  let chain: Promise<unknown> = Promise.resolve();
  let holders = 0;
  return {
    hold(fn, after) {
      holders += 1;
      const run = chain.then(async () => {
        try {
          return await fn();
        } finally {
          await after?.().catch(() => undefined);
          holders -= 1;
        }
      });
      chain = run.catch(() => undefined);
      return run;
    },
    busy: () => holders > 0,
  };
}

export type EarlyOutcome =
  /** The base was merged in (or already was). */
  | 'integrated'
  /** A conflict was left: the implementer got it. */
  | 'sent-to-agent'
  /** A step holds the checkout: it runs when the step ends. */
  | 'pending'
  /** Not now: the run is at merge, or was integrated early a moment ago. */
  | 'skipped';

export interface EarlyIntegrationDeps {
  lock: WorkspaceLock;
  integrate(): Promise<ActionResult>;
  /** Whether the run waits for or holds the merge slot (left to the queue). */
  atMerge(): boolean;
  /** Give the implementer the conflict and wait for its turn (absent: it waits for the flow). */
  toImplementer?(feedback: string): Promise<void>;
  /** Write `integration_pending_at`: set while pending, null once it ran. */
  markPending(at: string | null): Promise<void>;
  now?(): number;
  /** At most one early integration per run in this long (default 10 minutes). */
  minIntervalMs?: number;
}

const MIN_INTERVAL_MS = 10 * 60_000;

export function createEarlyIntegration(deps: EarlyIntegrationDeps) {
  const now = deps.now ?? Date.now;
  const minIntervalMs = deps.minIntervalMs ?? MIN_INTERVAL_MS;
  let pending = false;
  let last = Number.NEGATIVE_INFINITY;

  /** Integrate now (the caller holds the lock); a conflict goes to the implementer. */
  async function integrateHeld(): Promise<EarlyOutcome> {
    last = now();
    const result = await deps.integrate();
    const feedback = result.metadata?.feedback;
    if (result.ok && result.metadata?.outcome === 'conflict' && typeof feedback === 'string') {
      if (!deps.toImplementer) return 'integrated';
      await deps.toImplementer(feedback);
      return 'sent-to-agent';
    }
    return 'integrated';
  }

  return {
    /** Ask for an early integration (the base moved and the pull request no longer merges). */
    async request(): Promise<EarlyOutcome> {
      if (deps.atMerge() || now() - last < minIntervalMs) return 'skipped';
      if (deps.lock.busy()) {
        if (!pending) {
          pending = true;
          await deps.markPending(new Date(now()).toISOString());
        }
        return 'pending';
      }
      return deps.lock.hold(integrateHeld);
    },

    /** After a step, still holding the lock: the pending integration, before the next step. */
    async afterStep(): Promise<void> {
      if (!pending) return;
      pending = false;
      await deps.markPending(null);
      if (!deps.atMerge()) await integrateHeld();
    },
  };
}

export type EarlyIntegration = ReturnType<typeof createEarlyIntegration>;
