import { parseStoredJson } from '@funny/shared/json-validation';
/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: application
 *
 * Factory runs (change issue-factory): one row per admitted issue, holding the
 * run's state, its PR and the thread ids of its thread steps. The watcher reads
 * `activeByIssue` for admission (one run per issue) and the Factory tab lists
 * them per factory.
 */
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { okAsync, ResultAsync } from 'neverthrow';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { factoryRuns } from '../../db/schema.js';

const THREAD_IDS_SCHEMA = z.array(z.string());

/** States a run moves through; non-terminal ones block re-admitting the issue. */
export type FactoryRunState =
  | 'queued'
  | 'working'
  | 'pr_open'
  | 'waiting_ci'
  | 'fixing'
  | 'waiting_human'
  | 'merged'
  | 'failed'
  | 'stopped';

const TERMINAL_STATES = ['merged', 'failed', 'stopped'] as const satisfies FactoryRunState[];
const TERMINAL: ReadonlySet<FactoryRunState> = new Set(TERMINAL_STATES);

/**
 * Non-terminal states that do NOT hold a concurrency slot: the agent is done and
 * the run waits for a person. It still blocks re-admitting its issue.
 */
const PARKED_STATES = ['waiting_human'] as const satisfies FactoryRunState[];

export interface FactoryRunView {
  id: string;
  factoryId: string;
  issueNumber: number;
  prUrl: string | null;
  state: FactoryRunState;
  currentStep: string | null;
  threadIds: string[];
  startedAt: string;
  completedAt: string | null;
}

export type FactoryRunsError = { kind: 'storage'; message: string };

type Row = typeof factoryRuns.$inferSelect;

const storage = (error: unknown): FactoryRunsError => ({
  kind: 'storage',
  message: error instanceof Error ? error.message : String(error),
});

const toView = (row: Row): FactoryRunView => ({
  id: row.id,
  factoryId: row.factoryId,
  issueNumber: row.issueNumber,
  prUrl: row.prUrl,
  state: row.state as FactoryRunState,
  currentStep: row.currentStep,
  threadIds: parseThreadIds(row.threadIds),
  startedAt: row.startedAt,
  completedAt: row.completedAt,
});

function parseThreadIds(raw: string | null): string[] {
  if (!raw) return [];
  const parsed = parseStoredJson(THREAD_IDS_SCHEMA, raw, 'factory_runs.thread_ids');
  return parsed.ok ? parsed.value : [];
}

export interface StartRunInput {
  factoryId: string;
  issueNumber: number;
  state?: FactoryRunState;
  threadIds?: string[];
  currentStep?: string;
}

export interface UpdateRunInput {
  state?: FactoryRunState;
  currentStep?: string | null;
  prUrl?: string | null;
  threadIds?: string[];
}

function changesFor(input: UpdateRunInput): Partial<Row> | null {
  const changes: Partial<Row> = {};
  if (input.state !== undefined) {
    changes.state = input.state;
    if (TERMINAL.has(input.state)) changes.completedAt = new Date().toISOString();
  }
  if (input.currentStep !== undefined) changes.currentStep = input.currentStep;
  if (input.prUrl !== undefined) changes.prUrl = input.prUrl;
  if (input.threadIds !== undefined) changes.threadIds = JSON.stringify(input.threadIds);
  return Object.keys(changes).length === 0 ? null : changes;
}

export function createFactoryRunsRepository(
  deps: { newId: () => string } = { newId: () => crypto.randomUUID() },
) {
  /** Runs holding a concurrency slot: non-terminal and not parked for a person. */
  const inFlight = (factoryId: string): ResultAsync<FactoryRunView[], FactoryRunsError> =>
    ResultAsync.fromPromise(
      db
        .select()
        .from(factoryRuns)
        .where(
          and(
            eq(factoryRuns.factoryId, factoryId),
            notInArray(factoryRuns.state, [...TERMINAL_STATES, ...PARKED_STATES]),
          ),
        ),
      storage,
    ).map((rows) => rows.map(toView));

  return {
    /** Runs for a factory, newest first. */
    list(factoryId: string): ResultAsync<FactoryRunView[], FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryRuns)
          .where(eq(factoryRuns.factoryId, factoryId))
          .orderBy(desc(factoryRuns.startedAt)),
        storage,
      ).map((rows) => rows.map(toView));
    },

    /**
     * The in-flight run that owns `threadId`, if any — the completion lookup.
     * Only non-terminal rows are read (bounded by the factories' concurrency);
     * `thread_ids` is a JSON array, so the match itself happens here.
     */
    findByThreadId(threadId: string): ResultAsync<FactoryRunView | null, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryRuns)
          .where(notInArray(factoryRuns.state, [...TERMINAL_STATES])),
        storage,
      ).map((rows) => rows.map(toView).find((r) => r.threadIds.includes(threadId)) ?? null);
    },

    /** The non-terminal run for an issue, if any — the admission dedup check. */
    activeByIssue(
      factoryId: string,
      issueNumber: number,
    ): ResultAsync<FactoryRunView | null, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryRuns)
          .where(
            and(
              eq(factoryRuns.factoryId, factoryId),
              eq(factoryRuns.issueNumber, issueNumber),
              notInArray(factoryRuns.state, [...TERMINAL_STATES]),
            ),
          ),
        storage,
      ).map((rows) => (rows[0] ? toView(rows[0]) : null));
    },

    /** How many times an issue's run has failed — the retry cap. */
    failedCount(factoryId: string, issueNumber: number): ResultAsync<number, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db
          .select({ id: factoryRuns.id })
          .from(factoryRuns)
          .where(
            and(
              eq(factoryRuns.factoryId, factoryId),
              eq(factoryRuns.issueNumber, issueNumber),
              eq(factoryRuns.state, 'failed'),
            ),
          ),
        storage,
      ).map((rows) => rows.length);
    },

    inFlight,

    /** How many runs hold a concurrency slot (see `inFlight`). */
    countActive(factoryId: string): ResultAsync<number, FactoryRunsError> {
      return inFlight(factoryId).map((rows) => rows.length);
    },

    start(input: StartRunInput): ResultAsync<FactoryRunView, FactoryRunsError> {
      const row: Row = {
        id: deps.newId(),
        factoryId: input.factoryId,
        issueNumber: input.issueNumber,
        prUrl: null,
        state: input.state ?? 'queued',
        currentStep: input.currentStep ?? null,
        threadIds: JSON.stringify(input.threadIds ?? []),
        startedAt: new Date().toISOString(),
        completedAt: null,
      };
      return ResultAsync.fromPromise(db.insert(factoryRuns).values(row), storage).map(() =>
        toView(row),
      );
    },

    update(runId: string, input: UpdateRunInput): ResultAsync<void, FactoryRunsError> {
      const changes = changesFor(input);
      if (!changes) return okAsync(undefined);
      return ResultAsync.fromPromise(
        db.update(factoryRuns).set(changes).where(eq(factoryRuns.id, runId)),
        storage,
      ).map(() => undefined);
    },

    /**
     * Update a run only while it is still in `from` — so a late writer cannot
     * overwrite a transition another path already made (e.g. the launch marking
     * a run `working` after its thread already finished). Resolves whether the
     * run was in `from` and changed.
     */
    advance(
      runId: string,
      from: FactoryRunState,
      input: UpdateRunInput,
    ): ResultAsync<boolean, FactoryRunsError> {
      const changes = changesFor(input);
      if (!changes) return okAsync(false);
      return ResultAsync.fromPromise(
        db
          .update(factoryRuns)
          .set(changes)
          .where(and(eq(factoryRuns.id, runId), eq(factoryRuns.state, from)))
          .returning({ id: factoryRuns.id }),
        storage,
      ).map((rows) => rows.length > 0);
    },

    /** Drop a run that never started (its launch failed before any agent ran). */
    remove(runId: string): ResultAsync<void, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db.delete(factoryRuns).where(eq(factoryRuns.id, runId)),
        storage,
      ).map(() => undefined);
    },

    /** Terminal-mark several runs at once (e.g. when a factory is disabled). */
    stopMany(runIds: string[]): ResultAsync<void, FactoryRunsError> {
      if (runIds.length === 0) return okAsync(undefined);
      return ResultAsync.fromPromise(
        db
          .update(factoryRuns)
          .set({ state: 'stopped', completedAt: new Date().toISOString() })
          .where(inArray(factoryRuns.id, runIds)),
        storage,
      ).map(() => undefined);
    },
  };
}
