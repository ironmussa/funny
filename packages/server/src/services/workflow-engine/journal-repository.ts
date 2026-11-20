/**
 * @domain subdomain: Workflow Engine
 * @domain subdomain-type: supporting
 * @domain type: repository
 * @domain layer: infrastructure
 *
 * The workflow engine's journal on the server (change workflow-dag-engine,
 * D6): node executions in `workflow_node_executions`, one row per
 * (run, node, visit, attempt). The engine records an execution when it
 * starts, when it checkpoints, and when it ends; a run that starts again
 * loads its rows and replays them (rules in `@funny/pipelines` journal.ts).
 *
 * The engine's context is the host's: it may hold live objects (the
 * factory's action provider and progress reporter), so a `JournalCodec`
 * says what of it is stored and how a stored value becomes a context again.
 * Rows go with their factory run (foreign key, ON DELETE CASCADE).
 */
import type { ExecutionStatus, Journal, JournalEntry } from '@funny/pipelines';
import { parseStoredJson } from '@funny/shared/json-validation';
import { eq } from 'drizzle-orm';
import { Result, ResultAsync } from 'neverthrow';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { workflowNodeExecutions } from '../../db/schema.js';

export class JournalStorageError extends Error {
  constructor(cause: unknown) {
    super(
      `Workflow journal storage failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'JournalStorageError';
  }
}

const storage = (cause: unknown) => new JournalStorageError(cause);

const STATUSES = ['running', 'succeeded', 'failed', 'skipped', 'cancelled'] as const;
const STATUS_SCHEMA = z.enum(STATUSES);

/** One stored execution, with its JSON fields still undecoded by the host's codec. */
export interface StoredExecution {
  runId: string;
  nodeId: string;
  visit: string;
  attempt: number;
  status: ExecutionStatus;
  /** The stored output (what the codec encoded), or undefined. */
  output?: unknown;
  error?: string;
  data?: unknown;
  startedAt: number;
  finishedAt?: number;
}

type Row = typeof workflowNodeExecutions.$inferSelect;

/** A stored JSON column, or undefined when empty; a corrupt value throws (the load fails). */
function readJson(raw: string | null, label: string): unknown {
  if (raw === null) return undefined;
  const parsed = parseStoredJson(z.unknown(), raw, label);
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value;
}

function fromRow(row: Row): StoredExecution {
  const stored: StoredExecution = {
    runId: row.runId,
    nodeId: row.nodeId,
    visit: row.visit,
    attempt: row.attempt,
    status: STATUS_SCHEMA.parse(row.status),
    startedAt: row.startedAt,
  };
  const output = readJson(row.output, 'workflow execution output');
  const data = readJson(row.data, 'workflow execution data');
  if (output !== undefined) stored.output = output;
  if (data !== undefined) stored.data = data;
  if (row.error !== null) stored.error = row.error;
  if (row.finishedAt !== null) stored.finishedAt = row.finishedAt;
  return stored;
}

function toRow(e: StoredExecution): Row {
  return {
    runId: e.runId,
    nodeId: e.nodeId,
    visit: e.visit,
    attempt: e.attempt,
    status: e.status,
    output: e.output === undefined ? null : JSON.stringify(e.output),
    error: e.error ?? null,
    data: e.data === undefined ? null : JSON.stringify(e.data),
    startedAt: e.startedAt,
    finishedAt: e.finishedAt ?? null,
  };
}

export function createWorkflowJournalRepository() {
  return {
    /** Every recorded execution of `runId`. */
    load(runId: string): ResultAsync<StoredExecution[], JournalStorageError> {
      return ResultAsync.fromPromise(
        db.select().from(workflowNodeExecutions).where(eq(workflowNodeExecutions.runId, runId)),
        storage,
      ).andThen((rows) => Result.fromThrowable(() => rows.map(fromRow), storage)());
    },

    /** Insert the execution, or replace the row of the same (run, node, visit, attempt). */
    record(execution: StoredExecution): ResultAsync<void, JournalStorageError> {
      const row = toRow(execution);
      const { runId: _r, nodeId: _n, visit: _v, attempt: _a, ...changes } = row;
      return ResultAsync.fromPromise(
        db
          .insert(workflowNodeExecutions)
          .values(row)
          .onConflictDoUpdate({
            target: [
              workflowNodeExecutions.runId,
              workflowNodeExecutions.nodeId,
              workflowNodeExecutions.visit,
              workflowNodeExecutions.attempt,
            ],
            set: changes,
          }),
        storage,
      ).map(() => undefined);
    },

    /** Forget a run's executions (a retry from scratch). Deleting the run does it too. */
    deleteRun(runId: string): ResultAsync<void, JournalStorageError> {
      return ResultAsync.fromPromise(
        db.delete(workflowNodeExecutions).where(eq(workflowNodeExecutions.runId, runId)),
        storage,
      ).map(() => undefined);
    },
  };
}

export type WorkflowJournalRepository = ReturnType<typeof createWorkflowJournalRepository>;

/** What of the engine's context a journal stores, and how a stored value becomes one again. */
export interface JournalCodec<T> {
  encode(ctx: T): unknown;
  decode(stored: unknown): T;
}

/**
 * The engine's `Journal` port over the repository. The port is
 * Promise-based: a storage failure rejects, which the engine turns into a
 * failed run (load) or a failed node (record).
 */
export function databaseJournal<T>(
  repository: WorkflowJournalRepository,
  codec: JournalCodec<T>,
): Journal<T> {
  const orThrow = <V>(result: ResultAsync<V, JournalStorageError>) =>
    result.match(
      (value) => value,
      (error) => {
        throw error;
      },
    );
  return {
    load: async (runId) => {
      const stored = await orThrow(repository.load(runId));
      return stored.map((s): JournalEntry<T> => {
        const { output, ...rest } = s;
        return output === undefined ? rest : { ...rest, output: codec.decode(output) };
      });
    },
    record: async (entry) => {
      const { output, ...rest } = entry;
      const stored: StoredExecution =
        output === undefined ? rest : { ...rest, output: codec.encode(output) };
      await orThrow(repository.record(stored));
    },
  };
}
