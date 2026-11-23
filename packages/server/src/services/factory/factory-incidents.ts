/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: application
 *
 * Incidents (change factory-agent-roles, D10): a base branch that turned red
 * after a factory merge. A state machine with compare-and-set writers:
 *
 *   open ──▶ investigating ──▶ reported ──▶ closed
 *     └──────────────┴────────────┴──────────▶ closed
 *
 * - `open`: the base branch is red; nobody looks at it yet.
 * - `investigating`: the sentinel's thread runs.
 * - `reported`: the sentinel answered and the enablers were told (a revert
 *   pull request was opened when it named a merge).
 * - `closed`: the base branch is green again, the sentinel found that no
 *   factory merge broke it (`closedBy = 'unrelated'`), or a member closed it.
 *
 * At most one incident that is not closed exists per repository and base
 * branch (the partial unique index of migration 111), so opening one is an
 * insert that the index refuses when another is open. While one is not closed,
 * no factory on that repository admits issues.
 */

import {
  factoryIncidentCandidateSchema,
  factoryIncidentResultSchema,
  type FactoryIncident,
  type FactoryIncidentCandidate,
  type FactoryIncidentResult,
  type FactoryIncidentState,
} from '@funny/shared/contracts/factory';
import { parseStoredJson } from '@funny/shared/json-validation';
import { and, desc, eq, inArray, like, ne } from 'drizzle-orm';
import { ResultAsync } from 'neverthrow';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { factoryIncidents } from '../../db/schema.js';

/** Each transition and the states it may start from. */
const INCIDENT_TRANSITIONS = {
  investigate: { from: ['open'], to: 'investigating' },
  report: { from: ['open', 'investigating'], to: 'reported' },
  close: { from: ['open', 'investigating', 'reported'], to: 'closed' },
} as const satisfies Record<
  string,
  { from: readonly FactoryIncidentState[]; to: FactoryIncidentState }
>;

export type FactoryIncidentsError = { kind: 'storage'; message: string };

/** An incident with what only the server reads. */
export interface FactoryIncidentRecord extends FactoryIncident {
  /** The factory that opened it and runs its sentinel. */
  openedByFactory: string;
  /** The factories whose admissions it paused. */
  affectedFactories: string[];
  sentinelThreadId: string | null;
}

type Row = typeof factoryIncidents.$inferSelect;

const storage = (error: unknown): FactoryIncidentsError => ({
  kind: 'storage',
  message: error instanceof Error ? error.message : String(error),
});

const CANDIDATES = z.array(factoryIncidentCandidateSchema);
const FACTORY_IDS = z.array(z.string());

function parsed<Schema extends z.ZodType>(
  schema: Schema,
  raw: string | null,
  label: string,
): z.output<Schema> | null {
  if (!raw) return null;
  const result = parseStoredJson(schema, raw, label);
  return result.ok ? result.value : null;
}

const STATES: readonly FactoryIncidentState[] = ['open', 'investigating', 'reported', 'closed'];

const toRecord = (row: Row): FactoryIncidentRecord => ({
  id: row.id,
  repo: row.repo,
  baseBranch: row.baseBranch,
  state: STATES.find((state) => state === row.state) ?? 'open',
  redSha: row.redSha,
  openedAt: row.openedAt,
  closedAt: row.closedAt ?? null,
  candidates: parsed(CANDIDATES, row.candidates, 'factory_incidents.candidates') ?? [],
  result: parsed(factoryIncidentResultSchema, row.result ?? null, 'factory_incidents.result'),
  openedByFactory: row.openedByFactory,
  affectedFactories:
    parsed(FACTORY_IDS, row.affectedFactories ?? null, 'factory_incidents.affected_factories') ??
    [],
  sentinelThreadId: row.sentinelThreadId ?? null,
});

/** The incident as a member sees it (without the server's bookkeeping). */
export function publicIncident(record: FactoryIncidentRecord): FactoryIncident {
  const {
    openedByFactory: _opener,
    affectedFactories: _affected,
    sentinelThreadId: _thread,
    ...incident
  } = record;
  return incident;
}

export interface OpenIncidentInput {
  repo: string;
  baseBranch: string;
  redSha: string;
  candidates: FactoryIncidentCandidate[];
  factoryId: string;
}

export function createFactoryIncidentsRepository(
  deps: { newId: () => string; now: () => Date } = {
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  },
) {
  /** Move an incident along `transition`, only from its legal states; whether it moved. */
  const move = (
    id: string,
    transition: keyof typeof INCIDENT_TRANSITIONS,
    changes: Partial<Row>,
  ): ResultAsync<boolean, FactoryIncidentsError> => {
    const { from, to } = INCIDENT_TRANSITIONS[transition];
    return ResultAsync.fromPromise(
      db
        .update(factoryIncidents)
        .set({ ...changes, state: to })
        .where(and(eq(factoryIncidents.id, id), inArray(factoryIncidents.state, [...from])))
        .returning({ id: factoryIncidents.id }),
      storage,
    ).map((rows) => rows.length > 0);
  };

  const notClosed = ne(factoryIncidents.state, 'closed');

  return {
    /** The incident of a repository's base branch that is not closed, or null. */
    active(
      repo: string,
      baseBranch: string,
    ): ResultAsync<FactoryIncidentRecord | null, FactoryIncidentsError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryIncidents)
          .where(
            and(
              eq(factoryIncidents.repo, repo),
              eq(factoryIncidents.baseBranch, baseBranch),
              notClosed,
            ),
          ),
        storage,
      ).map((rows) => (rows[0] ? toRecord(rows[0]) : null));
    },

    /** The newest closed incident of a repository's base branch, or null. */
    lastClosed(
      repo: string,
      baseBranch: string,
    ): ResultAsync<
      (FactoryIncidentRecord & { closedBy: string | null }) | null,
      FactoryIncidentsError
    > {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryIncidents)
          .where(
            and(
              eq(factoryIncidents.repo, repo),
              eq(factoryIncidents.baseBranch, baseBranch),
              eq(factoryIncidents.state, 'closed'),
            ),
          )
          .orderBy(desc(factoryIncidents.openedAt))
          .limit(1),
        storage,
      ).map((rows) =>
        rows[0] ? { ...toRecord(rows[0]), closedBy: rows[0].closedBy ?? null } : null,
      );
    },

    /** The not-closed incident that paused `factoryId`, or null. */
    activeForFactory(
      factoryId: string,
    ): ResultAsync<FactoryIncidentRecord | null, FactoryIncidentsError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryIncidents)
          .where(
            and(
              notClosed,
              // Narrowed in SQL (a JSON array); the exact match is below.
              like(factoryIncidents.affectedFactories, `%${JSON.stringify(factoryId)}%`),
            ),
          ),
        storage,
      ).map(
        (rows) =>
          rows.map(toRecord).find((incident) => incident.affectedFactories.includes(factoryId)) ??
          null,
      );
    },

    /**
     * Open an incident, unless the repository's base branch already has one
     * that is not closed (the unique index refuses the insert): a
     * compare-and-set. Resolves the incident opened, or null.
     */
    open(
      input: OpenIncidentInput,
    ): ResultAsync<FactoryIncidentRecord | null, FactoryIncidentsError> {
      const row: Row = {
        id: deps.newId(),
        repo: input.repo,
        baseBranch: input.baseBranch,
        state: 'open',
        redSha: input.redSha,
        candidates: JSON.stringify(input.candidates),
        openedByFactory: input.factoryId,
        affectedFactories: JSON.stringify([input.factoryId]),
        sentinelThreadId: null,
        result: null,
        openedAt: deps.now().toISOString(),
        closedAt: null,
        closedBy: null,
      };
      return ResultAsync.fromPromise(
        db
          .insert(factoryIncidents)
          .values(row)
          .onConflictDoNothing()
          .returning({ id: factoryIncidents.id }),
        storage,
      ).map((rows) => (rows.length > 0 ? toRecord(row) : null));
    },

    /** Note that the incident paused `factoryId` too (its members may close it). */
    noteAffected(
      incident: FactoryIncidentRecord,
      factoryId: string,
    ): ResultAsync<void, FactoryIncidentsError> {
      if (incident.affectedFactories.includes(factoryId)) {
        return ResultAsync.fromSafePromise(Promise.resolve(undefined));
      }
      const affected = [...incident.affectedFactories, factoryId];
      return ResultAsync.fromPromise(
        db
          .update(factoryIncidents)
          .set({ affectedFactories: JSON.stringify(affected) })
          .where(and(eq(factoryIncidents.id, incident.id), notClosed)),
        storage,
      ).map(() => undefined);
    },

    /** `open → investigating`: the sentinel's thread started. */
    investigating: (id: string, threadId: string) =>
      move(id, 'investigate', { sentinelThreadId: threadId }),

    /** `open | investigating → reported`: what the sentinel answered and what was done. */
    report: (id: string, result: FactoryIncidentResult) =>
      move(id, 'report', { result: JSON.stringify(result) }),

    /**
     * Close it: `by` is a user id, `green` when the base branch recovered, or
     * `unrelated` when the sentinel found no factory merge behind it.
     */
    close: (id: string, by: string) =>
      move(id, 'close', { closedAt: deps.now().toISOString(), closedBy: by }),

    get(id: string): ResultAsync<FactoryIncidentRecord | null, FactoryIncidentsError> {
      return ResultAsync.fromPromise(
        db.select().from(factoryIncidents).where(eq(factoryIncidents.id, id)),
        storage,
      ).map((rows) => (rows[0] ? toRecord(rows[0]) : null));
    },
  };
}

export type FactoryIncidentsRepository = ReturnType<typeof createFactoryIncidentsRepository>;
