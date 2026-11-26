/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 *
 * A factory's lanes (openspec factory-lanes, D1): an issue labelled
 * `<lane label prefix><name>` runs on the branch `<lane branch prefix><name>`,
 * so several features go through one factory without sharing a branch. Nobody
 * registers a lane: the factory makes its row, and its branch, when it first
 * admits an issue that names it.
 *
 * `resolveLane` is the one place that reads a lane out of an issue's labels.
 * The repository below only stores what it decided.
 */
import { factoryBaseBranchSchema } from '@funny/shared/contracts/factory';
import { errorMessage } from '@funny/shared/errors';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { factoryLanes } from '../../db/schema.js';

export interface LanePrefixes {
  /** What a lane label starts with (`feature:`). */
  laneLabelPrefix: string;
  /** What a lane's branch starts with (`feature/`). */
  laneBranchPrefix: string;
}

/** Which lane an issue's labels name. */
export type LaneChoice =
  /** No lane label: the factory's own branch. */
  | { kind: 'none' }
  | { kind: 'lane'; name: string; branch: string }
  /** Two or more lane labels: the factory does not pick one. */
  | { kind: 'ambiguous'; names: string[] }
  /** A lane label whose name does not make a branch the factory may use. */
  | { kind: 'invalid'; label: string; message: string };

/**
 * The lane the labels name. Labels are matched without regard to case, as
 * GitHub treats them, and a lane's name is kept lower-cased. `reserved` are
 * the branches a lane may not be: the one the factory merges into, and the
 * repository's default branch.
 */
export function resolveLane(
  labels: readonly string[],
  prefixes: LanePrefixes,
  reserved: readonly string[] = [],
): LaneChoice {
  const prefix = prefixes.laneLabelPrefix.toLowerCase();
  if (!prefix) return { kind: 'none' };
  const named = labels.flatMap((label) => {
    const lowered = label.trim().toLowerCase();
    return lowered.startsWith(prefix) ? [lowered.slice(prefix.length).trim()] : [];
  });
  const names = [...new Set(named)];
  if (names.length === 0) return { kind: 'none' };
  if (names.length > 1) return { kind: 'ambiguous', names: [...names].sort() };

  const name = names[0]!;
  const label = `${prefixes.laneLabelPrefix}${name}`;
  const branch = `${prefixes.laneBranchPrefix}${name}`;
  if (name === '' || !factoryBaseBranchSchema.safeParse(branch).success) {
    return { kind: 'invalid', label, message: `"${branch}" is not a valid branch name` };
  }
  if (reserved.some((taken) => taken.toLowerCase() === branch.toLowerCase())) {
    return { kind: 'invalid', label, message: `"${branch}" is the branch the factory merges into` };
  }
  return { kind: 'lane', name, branch };
}

export type FactoryLaneState = 'active' | 'finished';

export interface FactoryLaneView {
  id: string;
  factoryId: string;
  name: string;
  branch: string;
  state: FactoryLaneState;
  /** Why the repository's workflows may not run for the lane's branch, or null. */
  ciWarning: string | null;
  createdAt: string;
  syncState: string;
  syncBaseSha: string | null;
  syncPrNumber: number | null;
  syncThreadId: string | null;
  /** When the agent turn the sync last judged ended. */
  syncTurnAt: string | null;
  syncAttempts: number;
  syncStartedAt: string | null;
  syncError: string | null;
  lastSyncedBaseSha: string | null;
  finishPrNumber: number | null;
}

export type FactoryLanesError = { kind: 'storage'; message: string };

type Row = typeof factoryLanes.$inferSelect;

const storage = (cause: unknown): FactoryLanesError => ({
  kind: 'storage',
  message: errorMessage(cause),
});

const toView = (row: Row): FactoryLaneView => ({
  id: row.id,
  factoryId: row.factoryId,
  name: row.name,
  branch: row.branch,
  state: row.state === 'finished' ? 'finished' : 'active',
  ciWarning: row.ciWarning ?? null,
  createdAt: row.createdAt,
  syncState: row.syncState,
  syncBaseSha: row.syncBaseSha ?? null,
  syncPrNumber: row.syncPrNumber ?? null,
  syncThreadId: row.syncThreadId ?? null,
  syncTurnAt: row.syncTurnAt ?? null,
  syncAttempts: row.syncAttempts,
  syncStartedAt: row.syncStartedAt ?? null,
  syncError: row.syncError ?? null,
  lastSyncedBaseSha: row.lastSyncedBaseSha ?? null,
  finishPrNumber: row.finishPrNumber ?? null,
});

const byName = (factoryId: string, name: string) =>
  and(eq(factoryLanes.factoryId, factoryId), eq(factoryLanes.name, name));

export function createFactoryLanesRepository(
  deps: { newId: () => string } = { newId: () => crypto.randomUUID() },
) {
  const find = (
    factoryId: string,
    name: string,
  ): ResultAsync<FactoryLaneView | null, FactoryLanesError> =>
    ResultAsync.fromPromise(
      db.select().from(factoryLanes).where(byName(factoryId, name)),
      storage,
    ).map(([row]) => (row ? toView(row) : null));

  return {
    find,

    /** The factory's lanes, oldest first. */
    list(factoryId: string): ResultAsync<FactoryLaneView[], FactoryLanesError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryLanes)
          .where(eq(factoryLanes.factoryId, factoryId))
          .orderBy(asc(factoryLanes.createdAt), asc(factoryLanes.name)),
        storage,
      ).map((rows) => rows.map(toView));
    },

    /**
     * The lane `name` of the factory, made when it has none. Two admissions
     * racing make one lane: the unique index on `(factory_id, name)` refuses
     * the second insert, and both read the same row back.
     */
    ensure(
      factoryId: string,
      lane: { name: string; branch: string },
    ): ResultAsync<FactoryLaneView, FactoryLanesError> {
      const row = {
        id: deps.newId(),
        factoryId,
        name: lane.name,
        branch: lane.branch,
        createdAt: new Date().toISOString(),
      };
      return ResultAsync.fromPromise(
        db.insert(factoryLanes).values(row).onConflictDoNothing(),
        storage,
      )
        .andThen(() => find(factoryId, lane.name))
        .map((stored) => stored ?? toView({ ...EMPTY_LANE, ...row }));
    },

    /** Record (or clear) why the lane's branch may get no checks. */
    setCiWarning(laneId: string, warning: string | null): ResultAsync<void, FactoryLanesError> {
      return ResultAsync.fromPromise(
        db.update(factoryLanes).set({ ciWarning: warning }).where(eq(factoryLanes.id, laneId)),
        storage,
      ).map(() => undefined);
    },

    /**
     * Write `changes` and the new sync state only while the lane's stored sync
     * state is one of `from`: a compare-and-set (`factory-lane-sync.ts` names
     * the transitions). Resolves whether this call made the move.
     */
    moveSync(
      laneId: string,
      move: { from: readonly string[]; to: string },
      changes: Partial<
        Pick<
          Row,
          | 'syncBaseSha'
          | 'syncPrNumber'
          | 'syncThreadId'
          | 'syncTurnAt'
          | 'syncAttempts'
          | 'syncStartedAt'
          | 'syncError'
          | 'lastSyncedBaseSha'
        >
      > = {},
    ): ResultAsync<boolean, FactoryLanesError> {
      return ResultAsync.fromPromise(
        db
          .update(factoryLanes)
          .set({ ...changes, syncState: move.to })
          .where(and(eq(factoryLanes.id, laneId), inArray(factoryLanes.syncState, [...move.from])))
          .returning({ id: factoryLanes.id }),
        storage,
      ).map((rows) => rows.length > 0);
    },

    /** Delete the lane's row; its branch is left on GitHub. Resolves whether a row was deleted. */
    remove(laneId: string): ResultAsync<boolean, FactoryLanesError> {
      return ResultAsync.fromPromise(
        db
          .delete(factoryLanes)
          .where(eq(factoryLanes.id, laneId))
          .returning({ id: factoryLanes.id }),
        storage,
      ).map((rows) => rows.length > 0);
    },
  };
}

/** The columns of a lane that a new one leaves at their defaults. */
const EMPTY_LANE = {
  state: 'active',
  ciWarning: null,
  syncState: 'idle',
  syncBaseSha: null,
  syncPrNumber: null,
  syncThreadId: null,
  syncTurnAt: null,
  syncAttempts: 0,
  syncStartedAt: null,
  syncError: null,
  lastSyncedBaseSha: null,
  finishPrNumber: null,
} satisfies Partial<Row>;

export type FactoryLanesRepository = ReturnType<typeof createFactoryLanesRepository>;
