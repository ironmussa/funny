/**
 * @domain subdomain: Watchers
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: RuntimeServiceProvider, ThreadMessaging, WSBroker
 *
 * Agent watchers (deferred-wake "snooze").
 *
 * An agent registers a watcher via the `funny_watch` tool: "wake this thread
 * in N ms". The watcher outlives the agent's turn. A single heartbeat scanner
 * (NOT one timer per watcher) polls the DB for due watchers — the same pattern
 * as `checkCompletedRuns` in automation-scheduler. The DB row is the source of
 * truth; this in-memory scanner holds no durable state, so a runner restart
 * just re-arms it (pending rows are picked up on the next scan).
 *
 * Pure snooze: funny runs no check command. When a watcher fires we wake the
 * agent (via `sendMessage`, which starts the agent if idle or queues the
 * follow-up if a turn is in flight) and let the agent decide to conclude or
 * reschedule (`createOrReschedule` for the same key).
 *
 * NOTE: distinct from the git file-watchers in `git-watcher-service.ts`.
 */

import type { Watcher, WatcherStatus, WSEvent } from '@funny/shared';
import { nanoid } from 'nanoid';

import { log } from '../lib/logger.js';
import { isAgentRunning } from './agent-runner.js';
import { getServices } from './service-registry.js';
import { shutdownManager, ShutdownPhase } from './shutdown-manager.js';
import { sendMessage } from './thread-service/messaging.js';
import { wsBroker } from './ws-broker.js';

// ── Tunables (see design.md open questions) ──────────────────────
const HEARTBEAT_MS = 5_000;
/** Sub-minute snoozes defeat the purpose and risk rapid wake loops. */
const MIN_DELAY_MS = 60_000;
/** Runaway backstop — the agent drives rescheduling, so this is rarely hit. */
const DEFAULT_MAX_WAKES = 20;
/** Hard lifetime ceiling so a never-concluded watcher can't poll forever. */
const DEFAULT_DEADLINE_MS = 60 * 60_000;

const NS = 'agent-watcher';

let scanner: ReturnType<typeof setInterval> | null = null;
/** Re-entrancy guard so a slow scan can't overlap the next heartbeat. */
let scanning = false;

type WatcherEventType =
  | 'watcher:created'
  | 'watcher:fired'
  | 'watcher:rescheduled'
  | 'watcher:completed'
  | 'watcher:cancelled';

function emit(userId: string, type: WatcherEventType, watcher: Watcher): void {
  wsBroker.emitToUser(userId, { type, threadId: watcher.threadId, data: { watcher } } as WSEvent);
}

// ── Create / reschedule (the sole creation path: funny_watch) ─────

export interface CreateOrRescheduleArgs {
  threadId: string;
  userId: string;
  /** Stable dedupe key per logical thing the agent is watching. */
  key: string;
  label: string;
  /** Delay until the next wake, in ms (clamped to MIN_DELAY_MS). */
  delayMs: number;
  maxWakes?: number;
  /** Relative ms from now; converted to an absolute deadline. */
  deadlineMs?: number;
}

/**
 * Idempotent by `(threadId, key)`: if a live watcher exists, re-arm it
 * (reschedule); otherwise create one. This unifies "schedule a check" and
 * "give it 5 more minutes" into a single operation, so a duplicate call —
 * or a nudge-induced second call — never produces two rows.
 */
export async function createOrReschedule(args: CreateOrRescheduleArgs): Promise<Watcher> {
  const now = Date.now();
  const delayMs = Math.max(args.delayMs, MIN_DELAY_MS);
  const nextWakeAt = now + delayMs;

  const existing = await getServices().watchers.getLiveWatcherByThreadKey(args.threadId, args.key);
  if (existing) {
    await getServices().watchers.updateWatcher(existing.id, {
      nextWakeAt,
      lastDelayMs: delayMs,
      status: 'pending',
    });
    const updated: Watcher = { ...existing, nextWakeAt, lastDelayMs: delayMs, status: 'pending' };
    emit(args.userId, 'watcher:rescheduled', updated);
    log.info('Watcher rescheduled', { namespace: NS, watcherId: existing.id, delayMs });
    return updated;
  }

  const iso = new Date(now).toISOString();
  const watcher: Watcher = {
    id: nanoid(),
    threadId: args.threadId,
    userId: args.userId,
    key: args.key,
    label: args.label,
    nextWakeAt,
    lastDelayMs: delayMs,
    wakeCount: 0,
    maxWakes: args.maxWakes ?? DEFAULT_MAX_WAKES,
    deadline: now + (args.deadlineMs ?? DEFAULT_DEADLINE_MS),
    status: 'pending',
    createdAt: iso,
    updatedAt: iso,
  };
  await getServices().watchers.insertWatcher(watcher);
  emit(args.userId, 'watcher:created', watcher);
  log.info('Watcher created', { namespace: NS, watcherId: watcher.id, delayMs });
  return watcher;
}

// ── Scanner ──────────────────────────────────────────────────────

async function scanOnce(): Promise<void> {
  if (scanning) return;
  scanning = true;
  try {
    const now = Date.now();
    const due = (await getServices().watchers.listDueWatchers(now)) as Watcher[];
    for (const w of due) {
      await fire(w, now).catch((err) => {
        log.error('Watcher fire failed', {
          namespace: NS,
          watcherId: w.id,
          error: (err as Error).message,
        });
      });
    }
  } catch (err) {
    log.error('Watcher scan failed', { namespace: NS, error: (err as Error).message });
  } finally {
    scanning = false;
  }
}

async function fire(watcher: Watcher, now: number): Promise<void> {
  // Caps: deadline passed or wake budget exhausted → expire, do NOT wake.
  const deadlinePassed = watcher.deadline != null && now > watcher.deadline;
  const overWakeBudget = watcher.wakeCount + 1 > watcher.maxWakes;
  if (deadlinePassed || overWakeBudget) {
    await setStatus(watcher, 'expired');
    emit(watcher.userId, 'watcher:completed', { ...watcher, status: 'expired' });
    log.info('Watcher expired', {
      namespace: NS,
      watcherId: watcher.id,
      reason: deadlinePassed ? 'deadline' : 'maxWakes',
    });
    return;
  }

  const wakeCount = watcher.wakeCount + 1;
  await getServices().watchers.updateWatcher(watcher.id, { status: 'fired', wakeCount });
  const fired: Watcher = { ...watcher, status: 'fired', wakeCount };
  emit(watcher.userId, 'watcher:fired', fired);

  // Wake the agent. If a turn is in flight we force-queue so we NEVER interrupt
  // it (regardless of the project's followUpMode); the queued follow-up is
  // delivered when the turn completes. If the thread is idle, sendMessage
  // starts the agent immediately.
  const result = await sendMessage({
    threadId: watcher.threadId,
    userId: watcher.userId,
    content: renderFollowUp(fired),
    forceQueue: isAgentRunning(watcher.threadId),
  });
  if (result.isErr()) {
    log.error('Watcher wake failed to deliver', {
      namespace: NS,
      watcherId: watcher.id,
      error: result.error.message,
    });
  }
}

function renderFollowUp(w: Watcher): string {
  const minutes = Math.max(1, Math.round(w.lastDelayMs / 60_000));
  return (
    `⏰ Watcher "${w.label}" fired — the ~${minutes} minute(s) you scheduled have elapsed ` +
    `(check #${w.wakeCount} of up to ${w.maxWakes}). Re-check now. If it's still not done, ` +
    `call funny_watch again with the same key to snooze; otherwise conclude.`
  );
}

// ── Cancel / list (UI panel) ─────────────────────────────────────

/** Cancel a watcher. Ownership-checked: only the owner may cancel. */
export async function cancel(watcherId: string, userId: string): Promise<boolean> {
  const w = (await getServices().watchers.getWatcher(watcherId)) as Watcher | undefined;
  if (!w || w.userId !== userId) return false;
  await setStatus(w, 'cancelled');
  emit(userId, 'watcher:cancelled', { ...w, status: 'cancelled' });
  log.info('Watcher cancelled', { namespace: NS, watcherId });
  return true;
}

export function listForUser(userId: string): Promise<Watcher[]> {
  return getServices().watchers.listWatchersByUser(userId) as Promise<Watcher[]>;
}

/** Remove a thread's watchers (called from the thread-delete path). */
export async function removeThreadWatchers(threadId: string): Promise<void> {
  await getServices().watchers.deleteWatchersByThread(threadId);
}

async function setStatus(watcher: Watcher, status: WatcherStatus): Promise<void> {
  await getServices().watchers.updateWatcher(watcher.id, { status });
}

// ── Lifecycle ────────────────────────────────────────────────────

/**
 * Start the heartbeat scanner. This IS the rehydration: pending watcher rows
 * already live in the DB, so starting the scanner resumes them — no in-memory
 * state to rebuild after a restart.
 */
export function startAgentWatchers(): void {
  if (scanner) return;
  scanner = setInterval(() => void scanOnce(), HEARTBEAT_MS);
  log.info('Agent watcher scanner started', { namespace: NS, heartbeatMs: HEARTBEAT_MS });
}

export function stopAgentWatchers(): void {
  if (scanner) {
    clearInterval(scanner);
    scanner = null;
  }
}

shutdownManager.register(
  'agent-watcher-manager',
  () => stopAgentWatchers(),
  ShutdownPhase.SERVICES,
);
