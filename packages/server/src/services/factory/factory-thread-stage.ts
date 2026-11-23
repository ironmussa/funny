import type { ThreadStage } from '@funny/shared';
/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: application
 * @domain emits: thread:stage-changed
 *
 * The kanban stage of a factory run's threads follows the run's state. The
 * runtime moves every thread to `review` when its agent finishes a turn, and
 * nothing moved a factory thread to `done`, so a merged run's threads stayed
 * in Review. Here the run decides: one table (`RUN_STAGE`) maps the run's
 * state to its threads' stage, and every run write that sets `state` calls
 * `syncRunThreadStages` afterwards.
 *
 * Each thread moves with a compare-and-set from its STORED stage, only from the
 * stages `STAGE_FROM` allows: a stage is never moved back out of `done`, and an
 * archived thread keeps its stage (unarchiving restores it).
 */
import type { FactoryRunState } from '@funny/shared/contracts/factory';
import { parseStoredJson } from '@funny/shared/json-validation';
import { and, eq } from 'drizzle-orm';
import { ResultAsync } from 'neverthrow';
import { z } from 'zod';

import { db, withDatabaseTransaction } from '../../db/index.js';
import { factoryRuns, stageHistory, threads } from '../../db/schema.js';
import { log } from '../../lib/logger.js';
import { relayToUser } from '../browser-events.js';

type RunThreadStage = Extract<ThreadStage, 'in_progress' | 'review' | 'done'>;

/** The stage a run's threads take in each run state; null leaves them as they are. */
const RUN_STAGE = {
  // Not started, or back in line: the thread (if any) has not been worked on yet.
  requested: null,
  queued: null,
  // The triage agent reads the issue; the run's own threads have not started.
  triaging: null,
  working: 'in_progress',
  fixing: 'in_progress',
  pr_open: 'in_progress',
  waiting_ci: 'in_progress',
  reviewing: 'in_progress',
  merging: 'in_progress',
  // A person has to look at it.
  waiting_human: 'review',
  needs_info: 'review',
  failed: 'review',
  no_change: 'review',
  merged: 'done',
  // Stopped by a person: they decide where its threads go.
  stopped: null,
} as const satisfies Record<FactoryRunState, RunThreadStage | null>;

/** The stored stages a thread may leave for each target stage. */
const STAGE_FROM = {
  in_progress: ['backlog', 'planning', 'review'],
  review: ['backlog', 'planning', 'in_progress'],
  done: ['backlog', 'planning', 'in_progress', 'review'],
} as const satisfies Record<RunThreadStage, readonly ThreadStage[]>;

/** The stage a run in `state` gives its threads, or null to leave them. */
export function stageForRunState(state: FactoryRunState): RunThreadStage | null {
  return RUN_STAGE[state] ?? null;
}

/** The move a thread at `from` makes when its run is in `state`, or null. */
export function threadStageMove(
  state: FactoryRunState,
  from: string,
): { from: ThreadStage; to: RunThreadStage } | null {
  const to = stageForRunState(state);
  if (!to) return null;
  const allowed: readonly string[] = STAGE_FROM[to];
  return allowed.includes(from) ? { from: from as ThreadStage, to } : null;
}

interface StageMoved {
  threadId: string;
  userId: string;
  projectId: string | null;
  fromStage: ThreadStage;
  toStage: RunThreadStage;
}

/** Move one thread (compare-and-set on its stored stage) and record the move. */
async function moveThreadStage(
  threadId: string,
  pick: (from: string) => { from: ThreadStage; to: RunThreadStage } | null,
): Promise<StageMoved | null> {
  return withDatabaseTransaction(async () => {
    const [thread] = await db
      .select({
        stage: threads.stage,
        archived: threads.archived,
        userId: threads.userId,
        projectId: threads.projectId,
      })
      .from(threads)
      .where(eq(threads.id, threadId));
    if (!thread || thread.archived) return null;
    const move = pick(thread.stage);
    if (!move) return null;
    const moved = await db
      .update(threads)
      .set({ stage: move.to })
      .where(and(eq(threads.id, threadId), eq(threads.stage, move.from), eq(threads.archived, 0)))
      .returning({ id: threads.id });
    if (moved.length === 0) return null;
    await db.insert(stageHistory).values({
      id: crypto.randomUUID(),
      threadId,
      fromStage: move.from,
      toStage: move.to,
      changedAt: new Date().toISOString(),
    });
    return {
      threadId,
      userId: thread.userId,
      projectId: thread.projectId ?? null,
      fromStage: move.from,
      toStage: move.to,
    };
  });
}

/**
 * Move the threads of a run to the stage its STORED state gives them, and tell
 * the owners' browsers. Never fails the caller: a failure is logged and the
 * threads keep their stage. Resolves the moves made.
 */
export function syncRunThreadStages(runId: string): ResultAsync<StageMoved[], never> {
  const sync = async (): Promise<StageMoved[]> => {
    const [run] = await db
      .select({ state: factoryRuns.state, threadIds: factoryRuns.threadIds })
      .from(factoryRuns)
      .where(eq(factoryRuns.id, runId));
    if (!run) return [];
    const state = run.state as FactoryRunState;
    if (!stageForRunState(state)) return [];
    const threadIds = parseIds(run.threadIds);
    const moves: StageMoved[] = [];
    for (const threadId of threadIds) {
      const moved = await moveThreadStage(threadId, (from) => threadStageMove(state, from));
      if (moved) moves.push(moved);
    }
    for (const move of moves) {
      relayToUser(move.userId, {
        type: 'thread:stage-changed',
        threadId: move.threadId,
        data: {
          fromStage: move.fromStage,
          toStage: move.toStage,
          projectId: move.projectId,
          reason: `factory run ${state}`,
        },
      });
      log.info('Factory run moved its thread stage', {
        namespace: 'factory',
        runId,
        threadId: move.threadId,
        runState: state,
        fromStage: move.fromStage,
        toStage: move.toStage,
      });
    }
    return moves;
  };
  return ResultAsync.fromPromise(sync(), (error) => error).orElse((error) => {
    log.warn('Factory run could not sync its thread stages', {
      namespace: 'factory',
      runId,
      error: error instanceof Error ? error.message : String(error),
    });
    return ResultAsync.fromSafePromise(Promise.resolve([] as StageMoved[]));
  });
}

/**
 * A role thread that belongs to no run (the sentinel's) is done once its
 * answer was read: to `done`, from the stages `STAGE_FROM` allows, and the
 * owner's browser is told. Never fails the caller.
 */
export function finishRoleThreadStage(threadId: string, reason: string): ResultAsync<void, never> {
  const allowed: readonly string[] = STAGE_FROM.done;
  const finish = async () => {
    const move = await moveThreadStage(threadId, (from) =>
      allowed.includes(from) ? { from: from as ThreadStage, to: 'done' } : null,
    );
    if (!move) return;
    relayToUser(move.userId, {
      type: 'thread:stage-changed',
      threadId,
      data: {
        fromStage: move.fromStage,
        toStage: move.toStage,
        projectId: move.projectId,
        reason,
      },
    });
  };
  return ResultAsync.fromPromise(finish(), (error) => error).orElse((error) => {
    log.warn('Factory role thread could not move to done', {
      namespace: 'factory',
      threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return ResultAsync.fromSafePromise(Promise.resolve(undefined));
  });
}

const THREAD_IDS_SCHEMA = z.array(z.string());

function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  const parsed = parseStoredJson(THREAD_IDS_SCHEMA, raw, 'factory_runs.thread_ids');
  return parsed.ok ? parsed.value : [];
}
