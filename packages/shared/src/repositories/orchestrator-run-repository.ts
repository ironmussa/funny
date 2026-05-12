/**
 * @domain subdomain: Orchestration
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 *
 * DB-agnostic repository for the orchestrator's run state.
 * Manages two tables:
 *   - `orchestrator_runs`     — one row per actively claimed thread
 *   - `thread_dependencies`   — directed edges (`thread_id` blocked_by `blocked_by`)
 *
 * Errors propagate as thrown exceptions; service-layer callers wrap
 * with `Result.fromThrowable` per CLAUDE.md's neverthrow boundary
 * mandate.
 */

import { and, eq, inArray, isNotNull, lte, sql } from 'drizzle-orm';

import type {
  AppDatabase,
  dbAll as dbAllFn,
  dbGet as dbGetFn,
  dbRun as dbRunFn,
} from '../db/connection.js';
import type * as sqliteSchema from '../db/schema.sqlite.js';

export interface OrchestratorRunRepositoryDeps {
  db: AppDatabase;
  schema: typeof sqliteSchema;
  dbAll: typeof dbAllFn;
  dbGet: typeof dbGetFn;
  dbRun: typeof dbRunFn;
}

export interface OrchestratorRunRow {
  threadId: string;
  pipelineRunId: string | null;
  attempt: number;
  nextRetryAtMs: number | null;
  lastEventAtMs: number;
  lastError: string | null;
  claimedAtMs: number;
  userId: string;
  tokensTotal: number;
  updatedAtMs: number;
}

export interface ClaimArgs {
  threadId: string;
  userId: string;
  /** Defaults to Date.now() when omitted. */
  now?: number;
}

export function createOrchestratorRunRepository(deps: OrchestratorRunRepositoryDeps) {
  const { db, schema, dbAll, dbGet, dbRun } = deps;
  const table = schema.orchestratorRuns;
  const deps_ = schema.threadDependencies;

  /**
   * Insert a new claim row. Throws if a row already exists for the
   * thread — callers should treat that as "another worker beat us to
   * it" and skip the dispatch.
   */
  async function claim(args: ClaimArgs): Promise<OrchestratorRunRow> {
    const now = args.now ?? Date.now();
    const row = {
      threadId: args.threadId,
      pipelineRunId: null,
      attempt: 0,
      nextRetryAtMs: null,
      lastEventAtMs: now,
      lastError: null,
      claimedAtMs: now,
      userId: args.userId,
      tokensTotal: 0,
      updatedAtMs: now,
    };
    await dbRun(db.insert(table).values(row));
    return row;
  }

  /** Remove the run row when the underlying pipeline reaches a terminal state. */
  async function release(threadId: string): Promise<void> {
    await dbRun(db.delete(table).where(eq(table.threadId, threadId)));
  }

  async function getRun(threadId: string): Promise<OrchestratorRunRow | undefined> {
    return dbGet<OrchestratorRunRow>(db.select().from(table).where(eq(table.threadId, threadId)));
  }

  async function listActiveRuns(): Promise<OrchestratorRunRow[]> {
    return dbAll<OrchestratorRunRow>(db.select().from(table));
  }

  async function listActiveRunsByUser(userId: string): Promise<OrchestratorRunRow[]> {
    return dbAll<OrchestratorRunRow>(db.select().from(table).where(eq(table.userId, userId)));
  }

  /** Threads currently claimed (used as a fast set membership check). */
  async function claimedThreadIds(): Promise<string[]> {
    const rows = await dbAll<{ threadId: string }>(
      db.select({ threadId: table.threadId }).from(table),
    );
    return rows.map((r) => r.threadId);
  }

  /** Update the pipeline run ID once the dispatcher hands the thread off. */
  async function setPipelineRunId(threadId: string, pipelineRunId: string): Promise<void> {
    await dbRun(
      db
        .update(table)
        .set({ pipelineRunId, updatedAtMs: Date.now() })
        .where(eq(table.threadId, threadId)),
    );
  }

  /**
   * Move a run into the retry queue. Increments `attempt`, stamps the
   * next-due timestamp, and records the most recent error so retry
   * decisions can inspect it.
   */
  async function setRetry(args: {
    threadId: string;
    attempt: number;
    nextRetryAtMs: number;
    lastError: string;
  }): Promise<void> {
    await dbRun(
      db
        .update(table)
        .set({
          attempt: args.attempt,
          nextRetryAtMs: args.nextRetryAtMs,
          lastError: args.lastError,
          updatedAtMs: Date.now(),
        })
        .where(eq(table.threadId, args.threadId)),
    );
  }

  /**
   * Touch the heartbeat — called from the dispatcher's progress
   * reporter on every pipeline event. Used by stall detection.
   */
  async function touchLastEvent(threadId: string, lastEventAtMs: number): Promise<void> {
    await dbRun(
      db
        .update(table)
        .set({ lastEventAtMs, updatedAtMs: Date.now() })
        .where(eq(table.threadId, threadId)),
    );
  }

  /** Add `delta` tokens to the cumulative counter. */
  async function addTokens(threadId: string, delta: number): Promise<void> {
    if (delta <= 0) return;
    await dbRun(
      db
        .update(table)
        .set({
          tokensTotal: sql`${table.tokensTotal} + ${delta}`,
          updatedAtMs: Date.now(),
        })
        .where(eq(table.threadId, threadId)),
    );
  }

  /** Runs whose retry deadline has passed (`next_retry_at_ms <= now`). */
  async function listDueRetries(now: number): Promise<OrchestratorRunRow[]> {
    return dbAll<OrchestratorRunRow>(
      db
        .select()
        .from(table)
        .where(and(isNotNull(table.nextRetryAtMs), lte(table.nextRetryAtMs, now))),
    );
  }

  // ── thread_dependencies ────────────────────────────────────

  async function addDependency(threadId: string, blockedBy: string): Promise<void> {
    await dbRun(db.insert(deps_).values({ threadId, blockedBy }));
  }

  async function removeDependency(threadId: string, blockedBy: string): Promise<void> {
    await dbRun(
      db.delete(deps_).where(and(eq(deps_.threadId, threadId), eq(deps_.blockedBy, blockedBy))),
    );
  }

  /**
   * Bulk lookup: for each thread in `threadIds`, return the list of
   * thread IDs that block it. Threads with no dependencies are absent
   * from the resulting map.
   */
  async function listDependenciesFor(threadIds: string[]): Promise<Map<string, string[]>> {
    if (threadIds.length === 0) return new Map();
    const rows = await dbAll<{ threadId: string; blockedBy: string }>(
      db.select().from(deps_).where(inArray(deps_.threadId, threadIds)),
    );
    const map = new Map<string, string[]>();
    for (const row of rows) {
      const arr = map.get(row.threadId);
      if (arr) arr.push(row.blockedBy);
      else map.set(row.threadId, [row.blockedBy]);
    }
    return map;
  }

  return {
    claim,
    release,
    getRun,
    listActiveRuns,
    listActiveRunsByUser,
    claimedThreadIds,
    setPipelineRunId,
    setRetry,
    touchLastEvent,
    addTokens,
    listDueRetries,
    addDependency,
    removeDependency,
    listDependenciesFor,
  };
}

export type OrchestratorRunRepository = ReturnType<typeof createOrchestratorRunRepository>;
