/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 *
 * Waiting for a factory agent step's thread to finish (change
 * factory-flow-execution, tasks 3.1 / 3.4). The source of truth is the thread's
 * persisted status in the server DB, which the runner writes. A waiter re-reads
 * it when the runner's terminal signal arrives (`signalThreadTerminal`, called
 * from `notifyTerminalStatusPersisted`) and on a slow poll, so a signal lost to a
 * restart or a race costs at most one poll interval.
 *
 * A thread that no longer exists, or that has run for longer than `staleMs`
 * without finishing, fails its step instead of holding the run forever.
 */

import { sleep as interruptibleSleep } from '@funny/shared/async';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { messages, threads } from '../../db/schema.js';

export type ThreadOutcome = {
  status: 'completed' | 'failed' | 'stopped' | 'interrupted' | 'missing' | 'stale' | 'cancelled';
  /** The agent's last message, for a completed thread. */
  output?: string;
  /** Why the step failed, when the thread itself did not say. */
  reason?: string;
};

const TERMINAL = new Set(['completed', 'failed', 'stopped', 'interrupted']);

/** How often a waiter re-reads the thread without a signal. */
const POLL_MS = 30 * 1000;
/** A thread running this long is treated as lost. */
const THREAD_STALE_MS = 24 * 60 * 60 * 1000;

export interface ThreadRecord {
  status: string;
  createdAt: string;
  /** When its agent last finished; reset when a follow-up runs it again. */
  completedAt?: string | null;
}

/**
 * Waiting on a follow-up: the thread's `completedAt` before it was sent. The
 * run it starts counts as finished only once `completedAt` differs — a
 * compare, not a clock check, so the runner's clock does not matter.
 */
export interface WaitAfter {
  completedAt: string | null;
  /** When the follow-up was sent: the stale limit counts from here. */
  sentAt: string;
}

export interface ThreadWaitsDeps {
  readThread?: (threadId: string) => Promise<ThreadRecord | null>;
  readOutput?: (threadId: string) => Promise<string>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  staleMs?: number;
}

const waiters = new Map<string, Set<() => void>>();

/** Wake every waiter of `threadId`: its terminal status was just persisted. */
export function signalThreadTerminal(threadId: string): void {
  for (const wake of waiters.get(threadId) ?? []) wake();
}

/** Whether a flow is waiting on the thread in this process (tests, diagnostics). */
export function isWaitingOn(threadId: string): boolean {
  return (waiters.get(threadId)?.size ?? 0) > 0;
}

async function dbReadThread(threadId: string): Promise<ThreadRecord | null> {
  const [row] = await db
    .select({
      status: threads.status,
      createdAt: threads.createdAt,
      completedAt: threads.completedAt,
    })
    .from(threads)
    .where(eq(threads.id, threadId));
  return row ?? null;
}

/**
 * Whether a commit pushed to the run's branch by someone else may be fetched
 * and run for this thread: only where it runs isolated in a sandbox. On a host
 * runner that commit's setup and tests would run as the enabler.
 */
export async function runsPushedCommits(threadId: string): Promise<boolean> {
  const [row] = await db
    .select({ runtime: threads.runtime })
    .from(threads)
    .where(eq(threads.id, threadId));
  return row?.runtime === 'sandbox';
}

/** The thread's last assistant message, or null when it has none. */
export async function lastThreadMessage(threadId: string): Promise<string | null> {
  const [row] = await db
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.role, 'assistant')))
    .orderBy(desc(messages.timestamp))
    .limit(1);
  return row?.content ?? null;
}

const dbReadOutput = async (threadId: string): Promise<string> =>
  (await lastThreadMessage(threadId)) ?? '';

export function createThreadWaits(deps: ThreadWaitsDeps = {}) {
  const readThread = deps.readThread ?? dbReadThread;
  const readOutput = deps.readOutput ?? dbReadOutput;
  const sleep = deps.sleep ?? interruptibleSleep;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? POLL_MS;
  const staleMs = deps.staleMs ?? THREAD_STALE_MS;

  /** The outcome once the thread is settled, or null while it still runs. */
  /** Whether the thread's last finish is a run after the one `after` names. */
  const finishedAfter = (thread: ThreadRecord, after?: WaitAfter) =>
    TERMINAL.has(thread.status) &&
    (after === undefined || (thread.completedAt ?? null) !== after.completedAt);

  async function finished(threadId: string, thread: ThreadRecord): Promise<ThreadOutcome> {
    const status = thread.status as ThreadOutcome['status'];
    return status === 'completed' ? { status, output: await readOutput(threadId) } : { status };
  }

  /** Running for longer than `staleMs` since it started (or was followed up). */
  function staleOutcome(threadId: string, startedAt: string): ThreadOutcome | null {
    if (now() - Date.parse(startedAt) <= staleMs) return null;
    return {
      status: 'stale',
      reason: `The agent thread ${threadId} did not finish within ${Math.round(staleMs / 3_600_000)} h.`,
    };
  }

  async function look(threadId: string, after?: WaitAfter): Promise<ThreadOutcome | null> {
    const thread = await readThread(threadId);
    if (!thread) {
      return { status: 'missing', reason: `The agent thread ${threadId} no longer exists.` };
    }
    if (finishedAfter(thread, after)) return finished(threadId, thread);
    return staleOutcome(threadId, after?.sentAt ?? thread.createdAt);
  }

  /** Sleep until the poll interval passes, the thread is signalled, or the run stops. */
  async function nap(threadId: string, signal: AbortSignal): Promise<void> {
    const woken = new AbortController();
    const wake = () => woken.abort();
    signal.addEventListener('abort', wake, { once: true });
    const set = waiters.get(threadId) ?? new Set();
    set.add(wake);
    waiters.set(threadId, set);
    try {
      await sleep(pollMs, woken.signal).catch(() => undefined);
    } finally {
      set.delete(wake);
      if (set.size === 0) waiters.delete(threadId);
      signal.removeEventListener('abort', wake);
    }
  }

  return async function waitThread(
    threadId: string,
    signal: AbortSignal,
    after?: WaitAfter,
  ): Promise<ThreadOutcome> {
    for (;;) {
      if (signal.aborted) return { status: 'cancelled', reason: 'The run was stopped.' };
      const outcome = await look(threadId, after);
      if (outcome) return outcome;
      await nap(threadId, signal);
    }
  };
}
