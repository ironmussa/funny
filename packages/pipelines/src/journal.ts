/**
 * The execution journal: the `Journal` port and its in-memory default.
 *
 * The engine records every node execution through the run's journal: when
 * it starts, any data the node checkpoints while it runs, and how it ended.
 * When a run starts, the engine loads the run's entries and replays them:
 *
 * - **succeeded / skipped**: not executed again; the recorded output is
 *   used, and loop conditions are evaluated on it, so the run takes the
 *   same path.
 * - **failed** with `onError: 'continue'`: stays failed, for the same reason.
 * - **running / cancelled** (started, not finished): executed again with
 *   `info.resume.recorded`, so the node can adopt the work it had started
 *   (e.g. the agent thread its checkpoint names) instead of starting new work.
 * - **failed** with `onError: 'fail'`: executed again from scratch; that
 *   failure is what ended the previous attempt of the run.
 *
 * An execution is keyed by node and `visit`: the visit numbers of the loop
 * regions around the node, outermost first, joined by dots ("1" outside
 * loops, "2.1" for the first visit of an inner loop during the second visit
 * of the outer one). `attempt` counts how many times the engine started that
 * execution, across resumes; retries inside one start share it.
 */

/** How a recorded execution stands. */
export type ExecutionStatus = 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

/** One node execution, as recorded. */
export interface JournalEntry<T> {
  runId: string;
  nodeId: string;
  /** Visit path of the loop regions around the node; see the module comment. */
  visit: string;
  /** From 1; a resumed execution records the next attempt. */
  attempt: number;
  status: ExecutionStatus;
  /** The context the node produced (its input when skipped). */
  output?: T;
  error?: string;
  /** What the node checkpointed while running (e.g. the thread it started). */
  data?: unknown;
  startedAt: number;
  finishedAt?: number;
}

/** The host port that stores node executions. */
export interface Journal<T> {
  /** Every entry of `runId` (the latest write per execution and attempt). */
  load(runId: string): Promise<JournalEntry<T>[]>;
  /** Insert or replace the entry for (runId, nodeId, visit, attempt). */
  record(entry: JournalEntry<T>): Promise<void>;
}

/** What a resumed node receives about its unfinished execution. */
export interface ResumeInfo {
  recorded: JournalEntry<unknown>;
}

const keyOf = (e: { runId: string; nodeId: string; visit: string; attempt: number }) =>
  `${e.runId}\u0000${e.nodeId}\u0000${e.visit}\u0000${e.attempt}`;

/** An in-memory journal. A run resumes from it only within one process. */
export function createMemoryJournal<T>(): Journal<T> & {
  entries(runId: string): JournalEntry<T>[];
} {
  const rows = new Map<string, JournalEntry<T>>();
  const entries = (runId: string) => [...rows.values()].filter((e) => e.runId === runId);
  return {
    entries,
    load: async (runId) => entries(runId).map((e) => ({ ...e })),
    record: async (entry) => {
      rows.set(keyOf(entry), { ...entry });
    },
  };
}

/** The latest attempt recorded for each execution, keyed by `nodeId` and `visit`. */
export function latestByExecution<T>(entries: JournalEntry<T>[]): Map<string, JournalEntry<T>> {
  const latest = new Map<string, JournalEntry<T>>();
  for (const e of entries) {
    const key = executionKey(e.nodeId, e.visit);
    const seen = latest.get(key);
    if (!seen || e.attempt > seen.attempt) latest.set(key, e);
  }
  return latest;
}

export const executionKey = (nodeId: string, visit: string) => `${nodeId}\u0000${visit}`;
