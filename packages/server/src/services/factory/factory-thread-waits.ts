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
 *
 * A finished turn is not always a finished agent: an agent that started a
 * background job or scheduled a watcher ends its turn and is woken later. A
 * `completed` thread with such a wake outstanding still counts as running
 * (`awaitsWake`), so the flow does not move on (and remove the checkout) under
 * an agent that is about to continue. So does one with a message it has not
 * answered yet (`awaitsInput`): one still in the thread's queue, or a user
 * message newer than its last finish (the queue just handed it over). A
 * follow-up sent while the agent was running waits in that queue, and the end
 * of the running turn is not the end of the follow-up (#449).
 *
 * The other way round, a finished agent is not always a finished turn: the
 * Claude CLI holds the turn open while a shell job it put in the background
 * still runs, and a job that never ends (a bare `wait` inside the read-only
 * sandbox waits for the sandbox's own proxies) keeps the thread `running` after
 * the agent wrote its answer. A waiter created with `quietAnswerMs` reports such
 * a thread as `idle` once its newest message is an answer (text, no tool call)
 * that nothing followed for that long; the caller decides what to do with it.
 */

import { sleep as interruptibleSleep } from '@funny/shared/async';
import { parseStoredJson } from '@funny/shared/json-validation';
import { and, desc, eq, gt, gte, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import {
  jobs,
  messageQueue,
  messages,
  threadEvents,
  threads,
  toolCalls,
  watchers,
} from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import { metric } from '../../lib/telemetry.js';

export type ThreadOutcome = {
  status:
    | 'completed'
    | 'failed'
    | 'stopped'
    | 'interrupted'
    | 'missing'
    | 'stale'
    | 'cancelled'
    /** Still running, but its agent answered and went quiet (`quietAnswerMs`). */
    | 'idle';
  /** The agent's last message, for a completed or idle thread. */
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

/** Something that wakes a thread's agent after its turn ended: a job or a watcher. */
export interface WakeSource {
  /** Still due: a running job, a pending watcher. */
  live: boolean;
  /** When it last changed: for one that ended, when its wake was due to start. */
  updatedAt: string;
}

/** How long after a job ended (or a watcher fired) its wake may take to start the agent. */
export const WAKE_GRACE_MS = 2 * 60 * 1000;

/**
 * Whether a finished thread is about to run again: a wake source is still due,
 * or one ended after the thread's last finish less than `graceMs` ago (its wake
 * is starting). The grace bounds a wake that failed to start the agent.
 */
function awaitsWake(
  thread: Pick<ThreadRecord, 'completedAt'>,
  sources: WakeSource[],
  now: number,
  graceMs = WAKE_GRACE_MS,
): boolean {
  const finishedAt = thread.completedAt ? Date.parse(thread.completedAt) : 0;
  return sources.some((source) => {
    if (source.live) return true;
    const at = Date.parse(source.updatedAt);
    return at > finishedAt && now - at < graceMs;
  });
}

/**
 * Whether a finished thread has a message it has not answered: still queued,
 * or written after its last finish. Held at most `graceMs` after that finish:
 * a queued message starts the agent within seconds once the turn ends, so one
 * that never does (a queue that failed to drain) does not hold the run forever.
 */
function awaitsInput(
  thread: Pick<ThreadRecord, 'completedAt'>,
  pendingInput: boolean,
  now: number,
  graceMs = WAKE_GRACE_MS,
): boolean {
  if (!pendingInput || !thread.completedAt) return false;
  return now - Date.parse(thread.completedAt) < graceMs;
}

/** The thread's newest message, for the quiet-answer check. */
export interface ThreadActivity {
  messageId: string;
  /** When it was written. */
  at: string;
  /** An assistant message with text and no tool call: an answer, not a step. */
  answered: boolean;
}

/** How long a read-only role's answer may sit in a thread that does not finish. */
export const ROLE_QUIET_ANSWER_MS = 10 * 60 * 1000;

/** An answer other than `before`, written before `since` (ms) with nothing after it. */
function wentQuiet(activity: ThreadActivity | null, before: string | null, since: number): boolean {
  if (!activity?.answered || activity.messageId === before) return false;
  return Date.parse(activity.at) < since;
}

export interface ThreadWaitsDeps {
  readThread?: (threadId: string) => Promise<ThreadRecord | null>;
  /** The thread's jobs and watchers that wake its agent; none by default in tests. */
  readWakeSources?: (threadId: string) => Promise<WakeSource[]>;
  /** Whether the thread has a message its agent has not answered since `completedAt`. */
  readPendingInput?: (threadId: string, completedAt: string) => Promise<boolean>;
  readOutput?: (threadId: string) => Promise<string>;
  /** The thread's newest message; read only when `quietAnswerMs` is set. */
  readActivity?: (threadId: string) => Promise<ThreadActivity | null>;
  /** Report a running thread whose answer went quiet for this long as `idle`; off when unset. */
  quietAnswerMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
  pollMs?: number;
  staleMs?: number;
}

/** One wait's memory across its looks. */
interface WaitState {
  after?: WaitAfter;
  /** The newest message at the first look of a follow-up wait (`undefined`: not looked yet). */
  before?: string | null;
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

/** A job that ended wakes the agent; a cancelled one does not. */
const JOB_WAKES = ['running', 'exited', 'failed', 'killed'];
/** A watcher wakes the agent while pending, and when it fires. */
const WATCHER_WAKES = ['pending', 'fired'];

async function dbReadWakeSources(threadId: string): Promise<WakeSource[]> {
  const [jobRows, watcherRows] = await Promise.all([
    db
      .select({ status: jobs.status, updatedAt: jobs.updatedAt })
      .from(jobs)
      .where(and(eq(jobs.threadId, threadId), inArray(jobs.status, JOB_WAKES))),
    db
      .select({ status: watchers.status, updatedAt: watchers.updatedAt })
      .from(watchers)
      .where(and(eq(watchers.threadId, threadId), inArray(watchers.status, WATCHER_WAKES))),
  ]);
  return [
    ...jobRows.map((row) => ({ live: row.status === 'running', updatedAt: row.updatedAt })),
    ...watcherRows.map((row) => ({ live: row.status === 'pending', updatedAt: row.updatedAt })),
  ];
}

async function dbReadPendingInput(threadId: string, completedAt: string): Promise<boolean> {
  const [queued] = await db
    .select({ id: messageQueue.id })
    .from(messageQueue)
    .where(eq(messageQueue.threadId, threadId))
    .limit(1);
  if (queued) return true;
  const [newer] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(
      and(
        eq(messages.threadId, threadId),
        eq(messages.role, 'user'),
        gt(messages.timestamp, completedAt),
      ),
    )
    .limit(1);
  return !!newer;
}

async function dbReadActivity(threadId: string): Promise<ThreadActivity | null> {
  const [row] = await db
    .select({
      id: messages.id,
      role: messages.role,
      content: messages.content,
      at: messages.timestamp,
    })
    .from(messages)
    .where(eq(messages.threadId, threadId))
    .orderBy(desc(messages.timestamp))
    .limit(1);
  if (!row) return null;
  const [call] = await db
    .select({ id: toolCalls.id })
    .from(toolCalls)
    .where(eq(toolCalls.messageId, row.id))
    .limit(1);
  const answered = row.role === 'assistant' && row.content.trim().length > 0 && !call;
  return { messageId: row.id, at: row.at, answered };
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

const AGENT_ERROR_SCHEMA = z.object({ error: z.string() });

/**
 * The last error the thread's agent reported (`agent:error`) since `since`, or
 * null: what a failed turn says that its outcome does not.
 */
export async function lastAgentError(threadId: string, since: string): Promise<string | null> {
  const [row] = await db
    .select({ data: threadEvents.data })
    .from(threadEvents)
    .where(
      and(
        eq(threadEvents.threadId, threadId),
        eq(threadEvents.eventType, 'agent:error'),
        gte(threadEvents.createdAt, since),
      ),
    )
    .orderBy(desc(threadEvents.createdAt))
    .limit(1);
  if (!row) return null;
  const parsed = parseStoredJson(AGENT_ERROR_SCHEMA, row.data, 'thread_events.data');
  return parsed.ok ? parsed.value.error : null;
}

const dbReadOutput = async (threadId: string): Promise<string> =>
  (await lastThreadMessage(threadId)) ?? '';

export function createThreadWaits(deps: ThreadWaitsDeps = {}) {
  const readThread = deps.readThread ?? dbReadThread;
  const readOutput = deps.readOutput ?? dbReadOutput;
  const readWakeSources = deps.readWakeSources ?? dbReadWakeSources;
  const readPendingInput = deps.readPendingInput ?? dbReadPendingInput;
  const readActivity = deps.readActivity ?? dbReadActivity;
  const quietAnswerMs = deps.quietAnswerMs;
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
    // SAFETY: look() calls this only once finishedAfter held, so status is one of TERMINAL's four.
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

  /** A completed turn whose agent a background job, a watcher or an unanswered message will wake. */
  async function wakeDue(threadId: string, thread: ThreadRecord): Promise<boolean> {
    if (thread.status !== 'completed') return false;
    if (awaitsWake(thread, await readWakeSources(threadId), now())) return true;
    if (!thread.completedAt) return false;
    return awaitsInput(thread, await readPendingInput(threadId, thread.completedAt), now());
  }

  /**
   * A running thread whose newest message is an answer nothing followed for
   * `quietAnswerMs`. On a follow-up, the message that was newest at the first
   * look is the previous answer and never counts (a compare, not a clock check).
   */
  async function quietAnswer(
    threadId: string,
    thread: ThreadRecord,
    wait: WaitState,
  ): Promise<ThreadOutcome | null> {
    if (quietAnswerMs === undefined || thread.status !== 'running') return null;
    const activity = await readActivity(threadId);
    if (wait.before === undefined) wait.before = wait.after ? (activity?.messageId ?? null) : null;
    if (!wentQuiet(activity, wait.before, now() - quietAnswerMs)) return null;
    return {
      status: 'idle',
      output: await readOutput(threadId),
      reason: `The agent of thread ${threadId} answered, but its turn did not end within ${Math.round(quietAnswerMs / 60_000)} min.`,
    };
  }

  async function look(threadId: string, wait: WaitState): Promise<ThreadOutcome | null> {
    const thread = await readThread(threadId);
    if (!thread) {
      return { status: 'missing', reason: `The agent thread ${threadId} no longer exists.` };
    }
    if (finishedAfter(thread, wait.after) && !(await wakeDue(threadId, thread))) {
      return finished(threadId, thread);
    }
    return (
      (await quietAnswer(threadId, thread, wait)) ??
      staleOutcome(threadId, wait.after?.sentAt ?? thread.createdAt)
    );
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
    const wait: WaitState = { after };
    for (;;) {
      if (signal.aborted) return { status: 'cancelled', reason: 'The run was stopped.' };
      const outcome = await look(threadId, wait);
      if (outcome) return outcome;
      await nap(threadId, signal);
    }
  };
}

type WaitThread = (
  threadId: string,
  signal: AbortSignal,
  after?: WaitAfter,
) => Promise<ThreadOutcome>;

/**
 * A read-only role's wait (triage, review). An answer its agent left in a turn
 * that never ended (`idle`) is its answer: the thread is stopped, so nothing
 * keeps running under the checkout, and the role reads it as finished.
 */
export function roleThreadWait(
  wait: WaitThread,
  stop: ((threadId: string) => Promise<void>) | undefined,
  run: { runId: string; repo: string },
): WaitThread {
  return async (threadId, signal, after) => {
    const outcome = await wait(threadId, signal, after);
    if (outcome.status !== 'idle') return outcome;
    log.warn('Issue factory took the answer of a role thread whose turn did not end', {
      namespace: 'factory',
      runId: run.runId,
      threadId,
      reason: outcome.reason,
    });
    metric('factory.integration_event', 1, {
      type: 'sum',
      attributes: { event: 'role_turn_unclosed', repo: run.repo },
    });
    await stop?.(threadId);
    return { status: 'completed', output: outcome.output };
  };
}
