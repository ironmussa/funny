/**
 * The journal from the scheduler's side: take a recorded execution as it
 * is (replay), or run the node and record the execution, resuming it when
 * it never finished. The rules are in `journal.ts`.
 */

import type { PipelineStateKind } from './engine.js';
import type { GraphNode } from './graph.js';
import type { ExecutionStatus, Journal, JournalEntry, ResumeInfo } from './journal.js';
import { runNodeTask, untilAfter, type TaskParams, type TaskResult } from './node-task.js';

/** A recorded execution the run takes as it is, without running the node. */
export type Replay<T> =
  | { kind: 'succeeded'; ctx: T }
  | { kind: 'skipped'; ctx: T }
  | { kind: 'failed'; ctx: T; error: string };

/**
 * What to do with `node`'s recorded execution: replay it, or (undefined)
 * run the node again, resuming it when it never finished.
 */
export function replayOf<T>(node: GraphNode<T>, entry: JournalEntry<T>): Replay<T> | undefined {
  const ctx = entry.output;
  if (ctx === undefined) return undefined;
  if (entry.status === 'succeeded' || entry.status === 'skipped')
    return { kind: entry.status, ctx };
  // A tolerated failure stays one, so the joins take the same path.
  if (entry.status === 'failed' && node.def.onError === 'continue') {
    return { kind: 'failed', ctx, error: entry.error ?? 'failed' };
  }
  return undefined;
}

/** The state change a replayed execution reports, as if it had just run. */
const REPLAY_STATE_KIND = {
  succeeded: 'completed',
  skipped: 'skipped',
  failed: 'error',
} as const satisfies Record<Replay<unknown>['kind'], PipelineStateKind>;

/** Take a recorded execution: report it, and evaluate the loop condition on its output. */
export async function replayNodeTask<T>(
  node: GraphNode<T>,
  replay: Replay<T>,
  params: TaskParams<T>,
): Promise<TaskResult<T>> {
  const { emit, iteration } = params;
  emit({
    kind: REPLAY_STATE_KIND[replay.kind],
    nodeName: node.def.name,
    ctx: replay.ctx,
    iteration,
    error: replay.kind === 'failed' ? replay.error : undefined,
  });
  if (replay.kind !== 'succeeded') return replay;
  return untilAfter(replay.ctx, params);
}

/** What a resumed execution receives: set when the previous attempt never finished. */
function resumeOf<T>(previous: JournalEntry<T> | undefined): ResumeInfo | undefined {
  if (previous?.status !== 'running' && previous?.status !== 'cancelled') return undefined;
  return { recorded: previous };
}

/** One execution to journal: who it is, and what was recorded for it before. */
export interface JournaledExecution<T> {
  journal: Journal<T> | undefined;
  runId: string;
  node: GraphNode<T>;
  visit: string;
  previous: JournalEntry<T> | undefined;
}

/** Run the node and record the execution, resuming `previous` if it never finished. */
export async function journaledNodeTask<T>(
  execution: JournaledExecution<T>,
  input: T,
  params: TaskParams<T>,
): Promise<TaskResult<T>> {
  const { journal, runId, node, visit, previous } = execution;
  const entry: JournalEntry<T> = {
    runId,
    nodeId: node.def.name,
    visit,
    attempt: (previous?.attempt ?? 0) + 1,
    status: 'running',
    startedAt: Date.now(),
  };
  const write = async (patch: Partial<JournalEntry<T>>) => {
    Object.assign(entry, patch);
    await journal?.record({ ...entry });
  };
  const failed = (cause: unknown): TaskResult<T> => ({
    kind: 'failed',
    ctx: input,
    error: journalError(cause),
  });

  const notStarted = await write({}).then(() => undefined, failed);
  if (notStarted) return notStarted;
  const resume = resumeOf(previous);
  const result = await runNodeTask(node, input, {
    ...params,
    info: { visit, resume, checkpoint: (data) => write({ data }) },
  });
  return write(finishedEntry(result)).then(() => result, failed);
}

/** The status recorded for a task result. */
function statusOf<T>(result: TaskResult<T>): ExecutionStatus {
  if (result.kind !== 'cancelled') return result.kind;
  // A node that committed its result before the abort did succeed.
  return result.ctx !== undefined ? 'succeeded' : 'cancelled';
}

/** The finished part of a journal entry for a task result. */
function finishedEntry<T>(result: TaskResult<T>): Partial<JournalEntry<T>> {
  const patch: Partial<JournalEntry<T>> = { status: statusOf(result), finishedAt: Date.now() };
  if (result.ctx !== undefined) patch.output = result.ctx;
  if (result.kind === 'failed') patch.error = result.error;
  return patch;
}

const journalError = (cause: unknown) =>
  `Could not record the execution in the journal: ${cause instanceof Error ? cause.message : String(cause)}`;
