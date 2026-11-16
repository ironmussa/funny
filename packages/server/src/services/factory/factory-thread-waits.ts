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
    .select({ status: threads.status, createdAt: threads.createdAt })
    .from(threads)
    .where(eq(threads.id, threadId));
  return row ?? null;
}

async function dbReadOutput(threadId: string): Promise<string> {
  const [row] = await db
    .select({ content: messages.content })
    .from(messages)
    .where(and(eq(messages.threadId, threadId), eq(messages.role, 'assistant')))
    .orderBy(desc(messages.timestamp))
    .limit(1);
  return row?.content ?? '';
}

export function createThreadWaits(deps: ThreadWaitsDeps = {}) {
  const readThread = deps.readThread ?? dbReadThread;
  const readOutput = deps.readOutput ?? dbReadOutput;
  const sleep = deps.sleep ?? interruptibleSleep;
  const now = deps.now ?? Date.now;
  const pollMs = deps.pollMs ?? POLL_MS;
  const staleMs = deps.staleMs ?? THREAD_STALE_MS;

  /** The outcome once the thread is settled, or null while it still runs. */
  async function look(threadId: string): Promise<ThreadOutcome | null> {
    const thread = await readThread(threadId);
    if (!thread) {
      return { status: 'missing', reason: `The agent thread ${threadId} no longer exists.` };
    }
    if (TERMINAL.has(thread.status)) {
      const status = thread.status as ThreadOutcome['status'];
      return status === 'completed' ? { status, output: await readOutput(threadId) } : { status };
    }
    if (now() - Date.parse(thread.createdAt) > staleMs) {
      return {
        status: 'stale',
        reason: `The agent thread ${threadId} did not finish within ${Math.round(staleMs / 3_600_000)} h.`,
      };
    }
    return null;
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

  return async function waitThread(threadId: string, signal: AbortSignal): Promise<ThreadOutcome> {
    for (;;) {
      if (signal.aborted) return { status: 'cancelled', reason: 'The run was stopped.' };
      const outcome = await look(threadId);
      if (outcome) return outcome;
      await nap(threadId, signal);
    }
  };
}
