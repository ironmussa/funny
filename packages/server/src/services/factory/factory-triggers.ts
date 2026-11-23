/**
 * Schedule triggers of an issue factory (change flow-triggers): what starts a
 * flow besides an issue. Each trigger holds a cron pattern, a flow and input
 * values; the watcher takes the due ones on its tick.
 *
 * An occurrence is taken with a compare-and-set on `next_run_at`, so when
 * several server instances tick the same factory only one starts it.
 *
 * @domain subdomain: Issue Factory
 * @domain type: repository
 * @domain layer: infrastructure
 */

import type { FactoryTrigger } from '@funny/shared/contracts/factory';
import { Cron } from 'croner';
import { and, asc, eq, isNotNull, lte } from 'drizzle-orm';
import { ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { factoryTriggers } from '../../db/schema.js';
import { parseStoredInputs } from './factory-runs.js';

export type FactoryTriggersError = { kind: 'storage'; message: string };

type Row = typeof factoryTriggers.$inferSelect;

const storage = (error: unknown): FactoryTriggersError => ({
  kind: 'storage',
  message: error instanceof Error ? error.message : String(error),
});

const toTrigger = (row: Row): FactoryTrigger => ({
  id: row.id,
  name: row.name,
  schedule: row.schedule,
  flowName: row.flowName,
  inputs: parseStoredInputs(row.inputs ?? null, 'factory_triggers.inputs'),
  enabled: row.enabled === 1,
  nextRunAt: row.nextRunAt ?? null,
});

/** Why `pattern` is not a schedule that can run, or null when it is. */
export function scheduleProblem(pattern: string): string | null {
  try {
    const cron = new Cron(pattern, { paused: true });
    const next = cron.nextRun();
    cron.stop();
    return next ? null : 'The schedule never occurs.';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** The first occurrence of `pattern` after `from`, or null when there is none. */
function nextOccurrence(pattern: string, from: Date): string | null {
  try {
    const cron = new Cron(pattern, { paused: true });
    const next = cron.nextRun(from);
    cron.stop();
    return next ? next.toISOString() : null;
  } catch {
    return null;
  }
}

/** An occurrence older than this when its tick comes was missed: it is not run late. */
export const MISSED_OCCURRENCE_MS = 5 * 60 * 1000;

export interface SaveTriggerInput {
  id?: string;
  factoryId: string;
  name: string;
  schedule: string;
  flowName: string;
  inputs: Record<string, string>;
  enabled: boolean;
}

export function createFactoryTriggersRepository(
  deps: { newId: () => string; now: () => Date } = {
    newId: () => crypto.randomUUID(),
    now: () => new Date(),
  },
) {
  return {
    list(factoryId: string): ResultAsync<FactoryTrigger[], FactoryTriggersError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryTriggers)
          .where(eq(factoryTriggers.factoryId, factoryId))
          .orderBy(asc(factoryTriggers.createdAt), asc(factoryTriggers.id)),
        storage,
      ).map((rows) => rows.map(toTrigger));
    },

    /**
     * Create a trigger, or change the factory's own one with `id`; null when
     * `id` names no trigger of this factory. The next occurrence is computed
     * from now, so an edited schedule never fires for a time already passed.
     */
    save(input: SaveTriggerInput): ResultAsync<FactoryTrigger | null, FactoryTriggersError> {
      const now = deps.now();
      const fields = {
        name: input.name,
        schedule: input.schedule,
        flowName: input.flowName,
        inputs: JSON.stringify(input.inputs),
        enabled: input.enabled ? 1 : 0,
        nextRunAt: input.enabled ? nextOccurrence(input.schedule, now) : null,
        updatedAt: now.toISOString(),
      };
      if (input.id) {
        return ResultAsync.fromPromise(
          db
            .update(factoryTriggers)
            .set(fields)
            .where(
              and(eq(factoryTriggers.id, input.id), eq(factoryTriggers.factoryId, input.factoryId)),
            )
            .returning(),
          storage,
        ).map((rows) => (rows[0] ? toTrigger(rows[0]) : null));
      }
      const row: Row = {
        id: deps.newId(),
        factoryId: input.factoryId,
        kind: 'schedule',
        createdAt: now.toISOString(),
        ...fields,
      };
      return ResultAsync.fromPromise(db.insert(factoryTriggers).values(row), storage).map(() =>
        toTrigger(row),
      );
    },

    /** Whether a trigger of the factory was removed. */
    remove(factoryId: string, id: string): ResultAsync<boolean, FactoryTriggersError> {
      return ResultAsync.fromPromise(
        db
          .delete(factoryTriggers)
          .where(and(eq(factoryTriggers.id, id), eq(factoryTriggers.factoryId, factoryId)))
          .returning({ id: factoryTriggers.id }),
        storage,
      ).map((rows) => rows.length > 0);
    },

    /** The factory's enabled triggers whose occurrence has come. */
    due(factoryId: string, now: Date): ResultAsync<FactoryTrigger[], FactoryTriggersError> {
      return ResultAsync.fromPromise(
        db
          .select()
          .from(factoryTriggers)
          .where(
            and(
              eq(factoryTriggers.factoryId, factoryId),
              eq(factoryTriggers.enabled, 1),
              isNotNull(factoryTriggers.nextRunAt),
              lte(factoryTriggers.nextRunAt, now.toISOString()),
            ),
          )
          .orderBy(asc(factoryTriggers.nextRunAt)),
        storage,
      ).map((rows) => rows.map(toTrigger));
    },

    /**
     * Take the occurrence `due` of a trigger: move `next_run_at` to the next
     * one after `now`, only while it still is `due`. False when another
     * instance (or an edit) already moved it.
     */
    take(
      trigger: Pick<FactoryTrigger, 'id' | 'schedule'>,
      due: string,
      now: Date,
    ): ResultAsync<boolean, FactoryTriggersError> {
      return ResultAsync.fromPromise(
        db
          .update(factoryTriggers)
          .set({ nextRunAt: nextOccurrence(trigger.schedule, now) })
          .where(and(eq(factoryTriggers.id, trigger.id), eq(factoryTriggers.nextRunAt, due)))
          .returning({ id: factoryTriggers.id }),
        storage,
      ).map((rows) => rows.length > 0);
    },
  };
}

export type FactoryTriggersRepository = ReturnType<typeof createFactoryTriggersRepository>;
