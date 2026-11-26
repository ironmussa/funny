/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: application
 *
 * The factory runs repository's writes of the spec stage (openspec
 * factory-spec-stage), split out of `factory-runs.ts`. Every write is a
 * compare-and-set: on the run's state (`QUEUE_TRANSITIONS.approveSpec` /
 * `reopenSpec`, or `needs_spec` for a spec writer's result) and on the spec
 * record as it was read, so a newer draft stored meanwhile is never
 * overwritten and never approved by a member who did not see it.
 */
import {
  pendingSpecDraft,
  type FactoryRunSpec,
  type FactoryTriage,
} from '@funny/shared/contracts/factory';
import { and, eq, inArray, isNull, type SQL } from 'drizzle-orm';
import { okAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { factoryRuns } from '../../db/schema.js';
import {
  parseRunSpec as parse,
  parseTriage,
  QUEUE_TRANSITIONS,
  storage,
  toView,
  type FactoryRunView,
  type FactoryRunsError,
  type Row,
} from './factory-runs-model.js';
import { afterStateWrite } from './factory-runs-writes.js';

/** Why an approval was refused: the run is not `needs_spec`, or its draft is not the one named. */
export type SpecApprovalRefusal = 'not-waiting-for-spec' | 'revision-moved' | 'no-draft';

/** The spec column as stored, for the compare-and-set (null: no spec record yet). */
const storedSpecIs = (raw: string | null): SQL =>
  raw === null ? isNull(factoryRuns.spec) : eq(factoryRuns.spec, raw);

/** The stored spec column of one run, unparsed, with its state. */
function readRaw(
  runId: string,
): ResultAsync<Pick<Row, 'state' | 'spec' | 'triage'> | null, FactoryRunsError> {
  return ResultAsync.fromPromise(
    db
      .select({ state: factoryRuns.state, spec: factoryRuns.spec, triage: factoryRuns.triage })
      .from(factoryRuns)
      .where(eq(factoryRuns.id, runId))
      .limit(1),
    storage,
  ).map((rows) => rows[0] ?? null);
}

/** Write `changes` while the run's state is one of `from` and its spec is still `raw`. */
function writeIfSpecIs(
  runId: string,
  raw: string | null,
  from: readonly string[],
  changes: Partial<Row>,
): ResultAsync<boolean, FactoryRunsError> {
  return ResultAsync.fromPromise(
    db
      .update(factoryRuns)
      .set(changes)
      .where(
        and(eq(factoryRuns.id, runId), inArray(factoryRuns.state, [...from]), storedSpecIs(raw)),
      )
      .returning({ id: factoryRuns.id }),
    storage,
  ).map((rows) => rows.length > 0);
}

/** The repository's writes of the spec stage. */
export function specOperations() {
  return {
    /** The runs waiting on their spec (`needs_spec`), of every factory: few, and read per spec turn. */
    waitingOnSpec(): ResultAsync<FactoryRunView[], FactoryRunsError> {
      return ResultAsync.fromPromise(
        db.select().from(factoryRuns).where(eq(factoryRuns.state, 'needs_spec')),
        storage,
      ).map((rows) => rows.map(toView));
    },

    /**
     * Record the spec record of a `needs_spec` run (its thread, a new result,
     * a problem), computed from the one read by `update`: retried once when a
     * concurrent write changed it meanwhile. Resolves the record written, or
     * null when the run is no longer `needs_spec`.
     */
    updateSpec(
      runId: string,
      update: (current: FactoryRunSpec | null) => FactoryRunSpec,
    ): ResultAsync<FactoryRunSpec | null, FactoryRunsError> {
      const attempt = (left: number): ResultAsync<FactoryRunSpec | null, FactoryRunsError> =>
        readRaw(runId).andThen((row) => {
          if (!row || row.state !== 'needs_spec') return okAsync(null);
          const next = update(parse(row.spec ?? null));
          return writeIfSpecIs(runId, row.spec ?? null, ['needs_spec'], {
            spec: JSON.stringify(next),
          }).andThen((wrote) => {
            if (wrote) return okAsync<FactoryRunSpec | null, FactoryRunsError>(next);
            return left > 0 ? attempt(left - 1) : okAsync(null);
          });
        });
      return attempt(1);
    },

    /**
     * A member approved the draft of `revision` (`needs_spec → requested`):
     * one compare-and-set writes the approval, a `ready` triage carrying the
     * draft's contract (`fromSpec`), and the state. The run keeps its
     * `queue_order`, so it goes ahead of anything sent after it. Refused when
     * the run left `needs_spec`, or its latest result is not the draft of
     * `revision`.
     */
    approveSpec(
      runId: string,
      revision: number,
      by: string,
    ): ResultAsync<
      { approved: true; spec: FactoryRunSpec } | { approved: false; reason: SpecApprovalRefusal },
      FactoryRunsError
    > {
      type Outcome =
        | { approved: true; spec: FactoryRunSpec }
        | { approved: false; reason: SpecApprovalRefusal };
      return readRaw(runId).andThen((row): ResultAsync<Outcome, FactoryRunsError> => {
        if (!row || row.state !== 'needs_spec') {
          return okAsync({ approved: false, reason: 'not-waiting-for-spec' });
        }
        const current = parse(row.spec ?? null);
        const draft = pendingSpecDraft(current);
        if (!current || current.revision !== revision) {
          return okAsync({ approved: false, reason: 'revision-moved' });
        }
        if (!draft) return okAsync({ approved: false, reason: 'no-draft' });
        const at = new Date().toISOString();
        const spec: FactoryRunSpec = {
          ...current,
          problem: undefined,
          approved: { spec: draft, revision, by, at },
        };
        const triage: FactoryTriage = {
          decision: 'ready',
          contract: draft.contract,
          at,
          fromSpec: true,
        };
        const { from, to } = QUEUE_TRANSITIONS.approveSpec;
        return writeIfSpecIs(runId, row.spec ?? null, from, {
          state: to,
          spec: JSON.stringify(spec),
          triage: JSON.stringify(triage),
          admittedAt: null,
          currentStep: null,
          launchStartedAt: null,
          completedAt: null,
          failureReason: null,
          waitReason: null,
        }).map((moved): Outcome =>
          moved ? { approved: true, spec } : { approved: false, reason: 'revision-moved' },
        );
      });
    },

    /**
     * A member reopened the run's spec (`reopenSpec`): from `requested` (an
     * approved spec not admitted yet) or a parked state. Drops the approval,
     * marks the spec's triage superseded and writes `needs_spec`. Resolves
     * the record written, or null when the run moved (in flight, say).
     */
    reopenSpec(runId: string): ResultAsync<FactoryRunSpec | null, FactoryRunsError> {
      const { from, to } = QUEUE_TRANSITIONS.reopenSpec;
      return readRaw(runId).andThen((row) => {
        if (!row || !from.some((state) => state === row.state)) return okAsync(null);
        const current = parse(row.spec ?? null) ?? { revision: 0 };
        const next: FactoryRunSpec = { ...current, approved: undefined, problem: undefined };
        const stored = parseTriage(row.triage ?? null);
        // An answer that no longer parses stays as it is: the run reads it as none.
        const triage = stored
          ? JSON.stringify({ ...stored, superseded: true })
          : (row.triage ?? null);
        return writeIfSpecIs(runId, row.spec ?? null, from, {
          state: to,
          spec: JSON.stringify(next),
          triage,
          completedAt: new Date().toISOString(),
          launchStartedAt: null,
          waitReason: null,
        })
          .andThen((moved) => afterStateWrite(runId, { state: to }, moved))
          .map((moved) => (moved ? next : null));
      });
    },
  };
}
