/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: application
 *
 * Batches of the issue factory's merge queue (openspec factory-integration,
 * D2-D3). A state machine with compare-and-set writers:
 *
 *   building ──▶ testing ──▶ merging ──▶ merged | partial
 *      ▲            │  ▲          │
 *      │            ▼  │          └──▶ failed
 *      ├──────── retesting ──▶ bisecting ──▶ split
 *      └── (rebuild: base moved, a member left; attempt + 1)
 *
 * - `building`: the leader merges the members onto the staging branch.
 * - `testing`: CI tests the finished batch on the queue branch.
 * - `retesting`: it was red; the same tree is tested once more (a flake?).
 * - `bisecting`: still red; halves are tested apart (`factory_batch_attempts`).
 * - `merging`: green on its base; the members' pull requests merge in order.
 * - Ends: `merged` (every member landed), `partial` (a merge was refused
 *   after earlier members landed), `split` (bisection sent culprits back and
 *   requeued the rest), `abandoned` (the leader stopped, or CI never ran on
 *   the queue branch), `failed` (the host could not be used).
 *
 * At most one batch that has not ended exists per repository and base branch
 * (the partial unique index of migration 114): starting one is an insert the
 * index refuses while another is active.
 */

import { parseStoredJson } from '@funny/shared/json-validation';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ResultAsync } from 'neverthrow';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { factoryBatchAttempts, factoryBatches } from '../../db/schema.js';

const BATCH_STATES = [
  'building',
  'testing',
  'retesting',
  'bisecting',
  'merging',
  'merged',
  'partial',
  'split',
  'abandoned',
  'failed',
] as const;
export type FactoryBatchState = (typeof BATCH_STATES)[number];

/** The states a batch ends in: its row keeps them, with `ended_at`. */
const ENDED: ReadonlySet<FactoryBatchState> = new Set([
  'merged',
  'partial',
  'split',
  'abandoned',
  'failed',
]);

const ACTIVE = ['building', 'testing', 'retesting', 'bisecting', 'merging'] as const;

/** Each transition and the states it may start from. */
export const BATCH_TRANSITIONS = {
  test: { from: ['building'], to: 'testing' },
  retest: { from: ['testing'], to: 'retesting' },
  bisect: { from: ['testing', 'retesting'], to: 'bisecting' },
  merge: { from: ['testing', 'retesting'], to: 'merging' },
  merged: { from: ['merging'], to: 'merged' },
  partial: { from: ['merging'], to: 'partial' },
  split: { from: ['bisecting'], to: 'split' },
  abandon: { from: [...ACTIVE], to: 'abandoned' },
  fail: { from: [...ACTIVE], to: 'failed' },
} as const satisfies Record<string, { from: readonly FactoryBatchState[]; to: FactoryBatchState }>;

export type FactoryBatchTransition = keyof typeof BATCH_TRANSITIONS;

/** One pull request in a batch: whose run it is, and the head commit the batch tests. */
const batchMemberSchema = z.object({
  runId: z.string(),
  factoryId: z.string(),
  /** The run's enabler: every write about this member uses their capped token. */
  userId: z.string(),
  projectId: z.string(),
  prNumber: z.number().int().positive(),
  headSha: z.string(),
});
export type FactoryBatchMember = z.infer<typeof batchMemberSchema>;

/** How a batch ended, for the runs and the metrics. */
const batchResultSchema = z.object({
  /** One line a person can read. */
  summary: z.string(),
  /** Members that landed, in order, with the commit each merge made. */
  landed: z.array(z.object({ runId: z.string(), sha: z.string() })).default([]),
  /** Members isolated as the cause of a red batch. */
  culprits: z.array(z.string()).default([]),
  /** Members sent back to the queue to be tested again. */
  requeued: z.array(z.string()).default([]),
  /** A red that turned green on the same tree. */
  flake: z.boolean().default(false),
  /** A merge was refused after earlier members landed (D3): the base holds an untested prefix. */
  partialLanding: z.boolean().default(false),
});
export type FactoryBatchResult = z.infer<typeof batchResultSchema>;

export interface FactoryBatch {
  id: string;
  repo: string;
  baseBranch: string;
  state: FactoryBatchState;
  attempt: number;
  leaderRunId: string;
  members: FactoryBatchMember[];
  baseSha: string | null;
  stagingBranch: string;
  queueBranch: string;
  queueSha: string | null;
  result: FactoryBatchResult | null;
  createdAt: string;
  endedAt: string | null;
}

export type FactoryBatchAttemptState = 'testing' | 'green' | 'red' | 'abandoned';

export interface FactoryBatchAttempt {
  id: string;
  batchId: string;
  /** The run ids of the members it tests. */
  members: string[];
  branch: string;
  sha: string | null;
  state: FactoryBatchAttemptState;
  createdAt: string;
}

export type FactoryBatchesError = { kind: 'storage'; message: string };

type BatchRow = typeof factoryBatches.$inferSelect;
type AttemptRow = typeof factoryBatchAttempts.$inferSelect;

const storage = (error: unknown): FactoryBatchesError => ({
  kind: 'storage',
  message: error instanceof Error ? error.message : String(error),
});

const MEMBERS = z.array(batchMemberSchema);
const RUN_IDS = z.array(z.string());

function stored<Schema extends z.ZodType>(
  schema: Schema,
  raw: string | null,
  label: string,
): z.output<Schema> | null {
  if (!raw) return null;
  const result = parseStoredJson(schema, raw, label);
  return result.ok ? result.value : null;
}

const toBatch = (row: BatchRow): FactoryBatch => ({
  id: row.id,
  repo: row.repo,
  baseBranch: row.baseBranch,
  state: BATCH_STATES.find((state) => state === row.state) ?? 'failed',
  attempt: row.attempt,
  leaderRunId: row.leaderRunId,
  members: stored(MEMBERS, row.members, 'factory_batches.members') ?? [],
  baseSha: row.baseSha ?? null,
  stagingBranch: row.stagingBranch,
  queueBranch: row.queueBranch,
  queueSha: row.queueSha ?? null,
  result: stored(batchResultSchema, row.result ?? null, 'factory_batches.result'),
  createdAt: row.createdAt,
  endedAt: row.endedAt ?? null,
});

const ATTEMPT_STATES: readonly FactoryBatchAttemptState[] = [
  'testing',
  'green',
  'red',
  'abandoned',
];

const toAttempt = (row: AttemptRow): FactoryBatchAttempt => ({
  id: row.id,
  batchId: row.batchId,
  members: stored(RUN_IDS, row.members, 'factory_batch_attempts.members') ?? [],
  branch: row.branch,
  sha: row.sha ?? null,
  state: ATTEMPT_STATES.find((state) => state === row.state) ?? 'abandoned',
  createdAt: row.createdAt,
});

export interface StartBatchInput {
  repo: string;
  baseBranch: string;
  leaderRunId: string;
  members: FactoryBatchMember[];
}

/** What a transition may write besides the state. */
export interface BatchChanges {
  members?: FactoryBatchMember[];
  baseSha?: string;
  queueSha?: string;
  result?: FactoryBatchResult;
}

export function createFactoryBatchesRepository(
  deps: { newId: () => string; now: () => Date } = {
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  },
) {
  const stamp = () => deps.now().toISOString();

  /** The columns a transition writes: the state, its time, and the changes given. */
  const columns = (to: FactoryBatchState, changes: BatchChanges): Partial<BatchRow> => {
    const now = stamp();
    const set: Partial<BatchRow> = { state: to, updatedAt: now };
    if (ENDED.has(to)) set.endedAt = now;
    if (changes.members) set.members = JSON.stringify(changes.members);
    if (changes.baseSha) set.baseSha = changes.baseSha;
    if (changes.queueSha) set.queueSha = changes.queueSha;
    if (changes.result) set.result = JSON.stringify(changes.result);
    return set;
  };

  /** Write an attempt only while it is testing; whether it was. */
  const writeTesting = (
    id: string,
    set: Partial<AttemptRow>,
  ): ResultAsync<boolean, FactoryBatchesError> =>
    ResultAsync.fromPromise(
      db
        .update(factoryBatchAttempts)
        .set(set)
        .where(and(eq(factoryBatchAttempts.id, id), eq(factoryBatchAttempts.state, 'testing')))
        .returning({ id: factoryBatchAttempts.id }),
      storage,
    ).map((moved) => moved.length > 0);

  return {
    /**
     * Start a batch for the repository's base branch; null when another one
     * is active there (the unique index refused it).
     */
    start(input: StartBatchInput): ResultAsync<FactoryBatch | null, FactoryBatchesError> {
      const id = deps.newId();
      const now = stamp();
      const row: BatchRow = {
        id,
        repo: input.repo,
        baseBranch: input.baseBranch,
        state: 'building',
        attempt: 1,
        leaderRunId: input.leaderRunId,
        members: JSON.stringify(input.members),
        baseSha: null,
        stagingBranch: `factory/staging/${id}`,
        queueBranch: `factory/queue/${id}`,
        queueSha: null,
        result: null,
        createdAt: now,
        updatedAt: now,
        endedAt: null,
      };
      return ResultAsync.fromPromise(
        db
          .insert(factoryBatches)
          .values(row)
          .onConflictDoNothing()
          .returning({ id: factoryBatches.id }),
        storage,
      ).map((inserted) => (inserted.length > 0 ? toBatch(row) : null));
    },

    /** Move a batch along `transition`, only from its legal states; whether it moved. */
    move(
      id: string,
      transition: FactoryBatchTransition,
      changes: BatchChanges = {},
    ): ResultAsync<boolean, FactoryBatchesError> {
      const { from, to } = BATCH_TRANSITIONS[transition];
      return ResultAsync.fromPromise(
        db
          .update(factoryBatches)
          .set(columns(to, changes))
          .where(and(eq(factoryBatches.id, id), inArray(factoryBatches.state, [...from])))
          .returning({ id: factoryBatches.id }),
        storage,
      ).map((moved) => moved.length > 0);
    },

    /**
     * Build the batch again (the base moved, a member left or changed): back
     * to `building` with the next attempt number, from a state CI was testing.
     */
    rebuild(id: string, members: FactoryBatchMember[]): ResultAsync<boolean, FactoryBatchesError> {
      return ResultAsync.fromPromise(
        db
          .update(factoryBatches)
          .set({
            state: 'building',
            attempt: sql`${factoryBatches.attempt} + 1`,
            members: JSON.stringify(members),
            queueSha: null,
            updatedAt: stamp(),
          })
          .where(
            and(
              eq(factoryBatches.id, id),
              inArray(factoryBatches.state, ['building', 'testing', 'retesting']),
            ),
          )
          .returning({ id: factoryBatches.id }),
        storage,
      ).map((moved) => moved.length > 0);
    },

    get(id: string): ResultAsync<FactoryBatch | null, FactoryBatchesError> {
      return ResultAsync.fromPromise(
        db.select().from(factoryBatches).where(eq(factoryBatches.id, id)).limit(1),
        storage,
      ).map((rows) => (rows[0] ? toBatch(rows[0]) : null));
    },

    /** The batch that has not ended on the repository's base branch, if any. */
    active(
      repo: string,
      baseBranch: string,
    ): ResultAsync<FactoryBatch | null, FactoryBatchesError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryBatches)
          .where(
            and(
              eq(factoryBatches.repo, repo),
              eq(factoryBatches.baseBranch, baseBranch),
              isNull(factoryBatches.endedAt),
            ),
          )
          .limit(1),
        storage,
      ).map((rows) => (rows[0] ? toBatch(rows[0]) : null));
    },

    /** Test `members` (run ids) of a red batch apart, on `branch`. */
    addAttempt(
      batchId: string,
      members: string[],
      branch: string,
    ): ResultAsync<FactoryBatchAttempt, FactoryBatchesError> {
      const row: AttemptRow = {
        id: deps.newId(),
        batchId,
        members: JSON.stringify(members),
        branch,
        sha: null,
        state: 'testing',
        result: null,
        createdAt: stamp(),
        endedAt: null,
      };
      return ResultAsync.fromPromise(db.insert(factoryBatchAttempts).values(row), storage).map(() =>
        toAttempt(row),
      );
    },

    /** Record the commit an attempt tests, while it is testing. */
    attemptSha(id: string, sha: string): ResultAsync<boolean, FactoryBatchesError> {
      return writeTesting(id, { sha });
    },

    /** End an attempt that is testing; whether it was. */
    endAttempt(
      id: string,
      state: Exclude<FactoryBatchAttemptState, 'testing'>,
      result?: unknown,
    ): ResultAsync<boolean, FactoryBatchesError> {
      const set: Partial<AttemptRow> = { state, endedAt: stamp() };
      if (result !== undefined) set.result = JSON.stringify(result);
      return writeTesting(id, set);
    },

    attemptsOf(batchId: string): ResultAsync<FactoryBatchAttempt[], FactoryBatchesError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryBatchAttempts)
          .where(eq(factoryBatchAttempts.batchId, batchId))
          .orderBy(asc(factoryBatchAttempts.createdAt)),
        storage,
      ).map((rows) => rows.map(toAttempt));
    },
  };
}

export type FactoryBatchesRepository = ReturnType<typeof createFactoryBatchesRepository>;
