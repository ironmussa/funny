/**
 * @domain subdomain: Factory
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 * @domain depends: Database
 *
 * DB-agnostic repository for `factory_flow_setups` (openspec
 * `factory-flow-bootstrap`, D4). Every state write goes through `transition`,
 * which enforces `FACTORY_FLOW_SETUP_WRITTEN_FROM` via compare-and-set.
 */

import { and, desc, eq, inArray, type SQL } from 'drizzle-orm';

import {
  FACTORY_FLOW_SETUP_OPEN_STATES,
  FACTORY_FLOW_SETUP_WRITTEN_FROM,
  isEndedFactoryFlowSetupState,
  type FactoryFlowSetupState,
} from '../factory-flow-setup-machine.js';
import type { RepoDeps } from './deps.js';

export type FactoryFlowSetupRepositoryDeps = RepoDeps;

export type FactoryFlowSetupRow = Omit<
  RepoDeps['schema']['factoryFlowSetups']['$inferSelect'],
  'state'
> & {
  state: FactoryFlowSetupState;
};

export type FactoryFlowSetupInsert = Omit<
  RepoDeps['schema']['factoryFlowSetups']['$inferInsert'],
  'state'
> & {
  state?: FactoryFlowSetupState;
};

/** Mutable non-state columns. State changes MUST go through `transition()`. */
export type FactoryFlowSetupPatch = Partial<
  Omit<FactoryFlowSetupRow, 'id' | 'projectId' | 'userId' | 'flowName' | 'state' | 'createdAt'>
>;

export interface FactoryFlowSetupTransitionExpect {
  /** Require the row to currently be in this specific state (narrower than `writtenFrom`). */
  fromState?: FactoryFlowSetupState;
  /** Require `proposed_file_sha` to still match (for confirm compare-and-set). */
  proposedFileSha?: string;
}

/** What an insert stores for the columns it leaves out. */
const INSERT_DEFAULTS = {
  threadId: null,
  worktreePath: null,
  runnerId: null,
  state: 'generating',
  builtinPrompts: null,
  proposedFile: null,
  proposedFileSha: null,
  commitVariant: null,
  facts: null,
  verifyJobId: null,
  verdicts: null,
  error: null,
  commitSha: null,
  prNumber: null,
  prUrl: null,
  endedAt: null,
} as const satisfies Partial<FactoryFlowSetupRow>;

export function createFactoryFlowSetupRepository(deps: FactoryFlowSetupRepositoryDeps) {
  const { db, schema, dbAll, dbGet, dbRun } = deps;
  const table = schema.factoryFlowSetups;

  async function insert(row: FactoryFlowSetupInsert): Promise<FactoryFlowSetupRow> {
    // SAFETY: the same object without its undefined fields, so still a FactoryFlowSetupInsert.
    const given = Object.fromEntries(
      Object.entries(row).filter(([, value]) => value !== undefined),
    ) as FactoryFlowSetupInsert;
    const full: FactoryFlowSetupRow = { ...INSERT_DEFAULTS, ...given };
    await dbRun(db.insert(table).values(full));
    return full;
  }

  async function getById(id: string): Promise<FactoryFlowSetupRow | undefined> {
    return dbGet<FactoryFlowSetupRow>(db.select().from(table).where(eq(table.id, id)));
  }

  async function getByThreadId(threadId: string): Promise<FactoryFlowSetupRow | undefined> {
    return dbGet<FactoryFlowSetupRow>(db.select().from(table).where(eq(table.threadId, threadId)));
  }

  /** The currently open (non-ended) setup for a member, project and flow, if any. */
  async function getOpenByUserProjectFlow(
    userId: string,
    projectId: string,
    flowName: string,
  ): Promise<FactoryFlowSetupRow | undefined> {
    return dbGet<FactoryFlowSetupRow>(
      db
        .select()
        .from(table)
        .where(
          and(
            eq(table.userId, userId),
            eq(table.projectId, projectId),
            eq(table.flowName, flowName),
            inArray(table.state, [...FACTORY_FLOW_SETUP_OPEN_STATES]),
          ),
        ),
    );
  }

  /** Most recent setup (open or ended) for a member, project and flow. */
  async function getLatestByUserProjectFlow(
    userId: string,
    projectId: string,
    flowName: string,
  ): Promise<FactoryFlowSetupRow | undefined> {
    return dbGet<FactoryFlowSetupRow>(
      db
        .select()
        .from(table)
        .where(
          and(
            eq(table.userId, userId),
            eq(table.projectId, projectId),
            eq(table.flowName, flowName),
          ),
        )
        .orderBy(desc(table.createdAt))
        .limit(1),
    );
  }

  /** All setups currently in any of the given states (used by reconciliation). */
  async function listByStates(
    states: readonly FactoryFlowSetupState[],
  ): Promise<FactoryFlowSetupRow[]> {
    if (states.length === 0) return [];
    return dbAll<FactoryFlowSetupRow>(
      db
        .select()
        .from(table)
        .where(inArray(table.state, [...states])),
    );
  }

  /**
   * Compare-and-set transition to `toState`. Written only when the row's stored
   * `state` is in `FACTORY_FLOW_SETUP_WRITTEN_FROM[toState]` (and meets any
   * narrower `expect` conditions). Returns `false` when nothing was written.
   */
  async function transition(
    id: string,
    toState: FactoryFlowSetupState,
    patch: FactoryFlowSetupPatch = {},
    expect?: FactoryFlowSetupTransitionExpect,
  ): Promise<boolean> {
    const allowedFrom = FACTORY_FLOW_SETUP_WRITTEN_FROM[toState] ?? [];
    if (allowedFrom.length === 0) return false;
    if (expect?.fromState !== undefined && !allowedFrom.includes(expect.fromState)) {
      return false;
    }

    const fromStates = expect?.fromState !== undefined ? [expect.fromState] : [...allowedFrom];
    const conditions: SQL[] = [eq(table.id, id), inArray(table.state, fromStates)];
    if (expect?.proposedFileSha !== undefined) {
      conditions.push(eq(table.proposedFileSha, expect.proposedFileSha));
    }

    const now = new Date().toISOString();
    const endedAt =
      patch.endedAt !== undefined
        ? patch.endedAt
        : isEndedFactoryFlowSetupState(toState)
          ? now
          : null;

    const rows = await dbAll<{ id: string }>(
      db
        .update(table)
        .set({
          ...patch,
          state: toState,
          updatedAt: patch.updatedAt ?? now,
          endedAt,
        })
        .where(and(...conditions))
        .returning({ id: table.id }),
    );
    return rows.length > 0;
  }

  /** Update non-state metadata columns (e.g. `threadId`, `worktreePath`, `facts`). */
  async function update(id: string, patch: FactoryFlowSetupPatch): Promise<boolean> {
    const rows = await dbAll<{ id: string }>(
      db
        .update(table)
        .set({
          ...patch,
          updatedAt: patch.updatedAt ?? new Date().toISOString(),
        })
        .where(eq(table.id, id))
        .returning({ id: table.id }),
    );
    return rows.length > 0;
  }

  return {
    insert,
    getById,
    getByThreadId,
    getOpenByUserProjectFlow,
    getLatestByUserProjectFlow,
    listByStates,
    transition,
    update,
  };
}

export type FactoryFlowSetupRepository = ReturnType<typeof createFactoryFlowSetupRepository>;
