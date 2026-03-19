/**
 * HTTP poll-based tunnel for server→runner communication.
 *
 * The reliable baseline transport. Every tunnel request is queued here.
 * Runners pick up queued requests via long-polling (GET /api/runners/tunnel/poll).
 * When a runner polls, the server either responds immediately (if requests are
 * queued) or holds the connection open for up to LONG_POLL_TIMEOUT_MS.
 *
 * WS push is an opportunistic accelerator layered on top — see ws-tunnel.ts.
 */

import type { TunnelPollItem } from '@funny/shared/runner-protocol';

import { log } from '../lib/logger.js';

/** How long the server holds a poll connection before returning [] */
const LONG_POLL_TIMEOUT_MS = 25_000;

/** A runner is considered "polling" if it polled within this window */
const POLL_STALE_MS = 35_000;

// ── Per-runner request queues ────────────────────────────

/** Queued tunnel requests waiting for a runner to pick them up */
const runnerQueues = new Map<string, TunnelPollItem[]>();

/** Active long-poll waiters — one per runner (the runner's pending GET) */
const pollWaiters = new Map<
  string,
  { resolve: (items: TunnelPollItem[]) => void; timer: ReturnType<typeof setTimeout> }
>();

/** Timestamp of the last poll from each runner */
const lastPollAt = new Map<string, number>();

// ── Public API ───────────────────────────────────────────

/**
 * Queue a tunnel request for a runner.
 * If the runner is currently long-polling, the request is delivered immediately.
 */
export function enqueueRequest(runnerId: string, item: TunnelPollItem): void {
  let queue = runnerQueues.get(runnerId);
  if (!queue) {
    queue = [];
    runnerQueues.set(runnerId, queue);
  }
  queue.push(item);

  // If the runner is currently waiting on a long-poll, wake it up
  const waiter = pollWaiters.get(runnerId);
  if (waiter) {
    clearTimeout(waiter.timer);
    pollWaiters.delete(runnerId);

    // Drain the entire queue
    const items = queue.splice(0);
    waiter.resolve(items);
  }
}

/**
 * Wait for queued requests (long-poll).
 * Returns immediately if requests are already queued,
 * otherwise holds for up to `timeoutMs` before returning [].
 */
export function waitForRequests(
  runnerId: string,
  timeoutMs: number = LONG_POLL_TIMEOUT_MS,
): Promise<TunnelPollItem[]> {
  // Update last-poll timestamp
  lastPollAt.set(runnerId, Date.now());

  // If there are already queued requests, drain and return immediately
  const queue = runnerQueues.get(runnerId);
  if (queue && queue.length > 0) {
    const items = queue.splice(0);
    return Promise.resolve(items);
  }

  // No requests queued — hold the connection until one arrives or timeout
  return new Promise<TunnelPollItem[]>((resolve) => {
    const timer = setTimeout(() => {
      pollWaiters.delete(runnerId);
      resolve([]);
    }, timeoutMs);

    // Only one waiter per runner (the runner has one poll loop)
    const existing = pollWaiters.get(runnerId);
    if (existing) {
      clearTimeout(existing.timer);
      existing.resolve([]); // Release the old waiter
    }

    pollWaiters.set(runnerId, { resolve, timer });
  });
}

/**
 * Check if a runner has been polling recently.
 * Used by runner-resolver to determine reachability.
 */
export function isPolling(runnerId: string, staleMs: number = POLL_STALE_MS): boolean {
  const ts = lastPollAt.get(runnerId);
  if (!ts) return false;
  return Date.now() - ts < staleMs;
}

/**
 * Clean up all state for a runner (e.g. on unregister).
 */
export function clearRunner(runnerId: string): void {
  runnerQueues.delete(runnerId);
  lastPollAt.delete(runnerId);

  const waiter = pollWaiters.get(runnerId);
  if (waiter) {
    clearTimeout(waiter.timer);
    waiter.resolve([]);
    pollWaiters.delete(runnerId);
  }

  log.info('Cleared HTTP tunnel state for runner', { namespace: 'http-tunnel', runnerId });
}

/**
 * Get the number of queued requests across all runners (for monitoring).
 */
export function getQueuedCount(): number {
  let count = 0;
  for (const queue of runnerQueues.values()) {
    count += queue.length;
  }
  return count;
}
