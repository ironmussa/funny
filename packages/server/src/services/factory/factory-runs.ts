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
import { and, desc, eq, inArray } from 'drizzle-orm';
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

const TERMINAL: ReadonlySet<FactoryRunState> = new Set(['merged', 'failed', 'stopped']);

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
  threadIds?: string[];
  currentStep?: string;
}

export interface UpdateRunInput {
  state?: FactoryRunState;
  currentStep?: string | null;
  prUrl?: string | null;
  threadIds?: string[];
}

export function createFactoryRunsRepository(
  deps: { newId: () => string } = { newId: () => crypto.randomUUID() },
) {
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
            and(eq(factoryRuns.factoryId, factoryId), eq(factoryRuns.issueNumber, issueNumber)),
          ),
        storage,
      ).map((rows) => {
        const active = rows.map(toView).find((r) => !TERMINAL.has(r.state));
        return active ?? null;
      });
    },

    /** How many runs are in flight for a factory (for the concurrency cap). */
    countActive(factoryId: string): ResultAsync<number, FactoryRunsError> {
      return ResultAsync.fromPromise(
        db.select().from(factoryRuns).where(eq(factoryRuns.factoryId, factoryId)),
        storage,
      ).map((rows) => rows.map(toView).filter((r) => !TERMINAL.has(r.state)).length);
    },

    start(input: StartRunInput): ResultAsync<FactoryRunView, FactoryRunsError> {
      const row: Row = {
        id: deps.newId(),
        factoryId: input.factoryId,
        issueNumber: input.issueNumber,
        prUrl: null,
        state: 'queued',
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
      const changes: Partial<Row> = {};
      if (input.state !== undefined) {
        changes.state = input.state;
        if (TERMINAL.has(input.state)) changes.completedAt = new Date().toISOString();
      }
      if (input.currentStep !== undefined) changes.currentStep = input.currentStep;
      if (input.prUrl !== undefined) changes.prUrl = input.prUrl;
      if (input.threadIds !== undefined) changes.threadIds = JSON.stringify(input.threadIds);
      if (Object.keys(changes).length === 0) return okAsync(undefined);
      return ResultAsync.fromPromise(
        db.update(factoryRuns).set(changes).where(eq(factoryRuns.id, runId)),
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
