/**
 * @domain subdomain: Issue Factory
 * @domain subdomain-type: core
 * @domain type: repository
 * @domain layer: infrastructure
 *
 * A run's step timings (openspec factory-step-timings, D1): each execution of
 * a node of its flow, read from the journal the workflow engine already writes
 * (`workflow_node_executions`). Only the small columns are read, never a
 * step's output, error or stored data, and the listed runs in one query per
 * chunk of ids.
 */
import type { FactoryStepTiming, FactoryStepTimingStatus } from '@funny/shared/contracts/factory';
import { asc, inArray } from 'drizzle-orm';
import { okAsync, ResultAsync } from 'neverthrow';

import { db } from '../../db/index.js';
import { workflowNodeExecutions } from '../../db/schema.js';

/** Run ids per query: well under SQLite's bound-parameter limit. */
const RUN_IDS_PER_QUERY = 500;

const STATUSES: ReadonlySet<string> = new Set<FactoryStepTimingStatus>([
  'running',
  'succeeded',
  'failed',
  'skipped',
  'cancelled',
]);

const isStatus = (status: string): status is FactoryStepTimingStatus => STATUSES.has(status);

export interface ExecutionTimeRow {
  runId: string;
  nodeId: string;
  visit: string;
  attempt: number;
  status: string;
  startedAt: number;
  finishedAt: number | null;
}

/** The rows of each run, in start order, as timings; a status the contract does not know is dropped. */
export function groupStepTimings(
  rows: readonly ExecutionTimeRow[],
): Map<string, FactoryStepTiming[]> {
  const byRun = new Map<string, FactoryStepTiming[]>();
  const ordered = [...rows].sort((a, b) => a.startedAt - b.startedAt);
  for (const row of ordered) {
    if (!isStatus(row.status)) continue;
    const timings = byRun.get(row.runId) ?? [];
    timings.push({
      step: row.nodeId,
      visit: row.visit,
      attempt: row.attempt,
      status: row.status,
      startedAt: new Date(row.startedAt).toISOString(),
      finishedAt: row.finishedAt === null ? null : new Date(row.finishedAt).toISOString(),
    });
    byRun.set(row.runId, timings);
  }
  return byRun;
}

function readChunk(runIds: string[]): Promise<ExecutionTimeRow[]> {
  return db
    .select({
      runId: workflowNodeExecutions.runId,
      nodeId: workflowNodeExecutions.nodeId,
      visit: workflowNodeExecutions.visit,
      attempt: workflowNodeExecutions.attempt,
      status: workflowNodeExecutions.status,
      startedAt: workflowNodeExecutions.startedAt,
      finishedAt: workflowNodeExecutions.finishedAt,
    })
    .from(workflowNodeExecutions)
    .where(inArray(workflowNodeExecutions.runId, runIds))
    .orderBy(asc(workflowNodeExecutions.startedAt));
}

/** The step timings of `runIds`, by run id; a run with no execution is absent. */
export function stepTimingsFor<E>(
  runIds: readonly string[],
  onError: (cause: unknown) => E,
): ResultAsync<Map<string, FactoryStepTiming[]>, E> {
  if (runIds.length === 0) return okAsync(new Map());
  const chunks: string[][] = [];
  for (let index = 0; index < runIds.length; index += RUN_IDS_PER_QUERY) {
    chunks.push(runIds.slice(index, index + RUN_IDS_PER_QUERY));
  }
  return ResultAsync.fromPromise(Promise.all(chunks.map(readChunk)), onError).map((parts) =>
    groupStepTimings(parts.flat()),
  );
}

/** The runs, each with its step timings (none for a run that has not started a step). */
export function withStepTimings<R extends { id: string }, E>(
  runs: R[],
  onError: (cause: unknown) => E,
): ResultAsync<Array<R & { stepTimings: FactoryStepTiming[] }>, E> {
  return stepTimingsFor(
    runs.map((run) => run.id),
    onError,
  ).map((byRun) => runs.map((run) => ({ ...run, stepTimings: byRun.get(run.id) ?? [] })));
}
