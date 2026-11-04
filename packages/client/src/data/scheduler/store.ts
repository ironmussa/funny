import type { DomainError } from '@funny/shared/errors';
import type { ResultAsync } from 'neverthrow';

import { api } from '@/lib/api';
import type { SchedulerRun } from '@/lib/api/scheduler';
import { createClientLogger } from '@/lib/client-logger';

import type { DataLayer } from '../data-layer';
import { createEntityStore, type EntityStore } from '../entities';
import { unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';

/**
 * Scheduler-claimed runs, one row per thread (keyed by thread id), loaded from
 * the queue endpoint and patched by the `thread:claimed` / `thread:dispatched`
 * / `thread:retry-queued` / `thread:released` events.
 */

const log = createClientLogger('scheduler');

export type SchedulerRow = SchedulerRun & { id: string };

export function getSchedulerData(layer: DataLayer = getDataLayer()): EntityStore<SchedulerRow> {
  return layer.own('scheduler-runs', () => {
    const data = createEntityStore<SchedulerRow>(layer, 'scheduler-runs');
    return {
      value: data,
      dispose: () => void data.collection.cleanup({ dependents: true }).catch(() => undefined),
    };
  });
}

export function schedulerRunsQuery(layer: DataLayer = getDataLayer()) {
  return {
    queryKey: ['scheduler-runs'] as const,
    staleTime: 0,
    queryFn: async (): Promise<number> => {
      const { runs } = await unwrapResult(api.listSchedulerRuns()).catch((error: Error) => {
        log.warn('failed to load scheduler runs', { error: error.message });
        throw error;
      });
      getSchedulerData(layer).replaceAll(runs.map((r) => ({ ...r, id: r.threadId })));
      return runs.length;
    },
  };
}

/** Ask the scheduler to tick now, then re-pull the queue. */
export function refreshScheduler(
  layer: DataLayer = getDataLayer(),
): ResultAsync<void, DomainError> {
  return api
    .refreshScheduler()
    .map(() => {
      void layer.queryClient.invalidateQueries({ queryKey: ['scheduler-runs'] });
    })
    .mapErr((error) => {
      log.warn('failed to refresh scheduler', { error: error.message });
      return error;
    });
}

/** Merge an event into a thread's run, creating the row on its first event. */
function patchRun(
  threadId: string,
  patch: (prev: SchedulerRow | undefined) => Partial<SchedulerRun>,
  layer: DataLayer,
): void {
  const data = getSchedulerData(layer);
  const prev = data.getSynced(threadId);
  const now = Date.now();
  const base: SchedulerRow = prev ?? {
    id: threadId,
    threadId,
    pipelineRunId: null,
    attempt: 0,
    nextRetryAtMs: null,
    lastEventAtMs: now,
    lastError: null,
    claimedAtMs: now,
    userId: '',
    tokensTotal: 0,
    updatedAtMs: now,
  };
  data.upsert([{ ...base, ...patch(prev), lastEventAtMs: now, updatedAtMs: now }]);
}

export function applyRunClaimed(
  threadId: string,
  event: { userId?: string; attempt?: number },
  layer: DataLayer = getDataLayer(),
): void {
  patchRun(
    threadId,
    (prev) => ({
      userId: event.userId ?? prev?.userId ?? '',
      attempt: event.attempt ?? prev?.attempt ?? 0,
      lastError: null,
      nextRetryAtMs: null,
    }),
    layer,
  );
}

export function applyRunDispatched(
  threadId: string,
  event: { pipelineRunId?: string },
  layer: DataLayer = getDataLayer(),
): void {
  patchRun(threadId, () => ({ pipelineRunId: event.pipelineRunId ?? null }), layer);
}

export function applyRunRetryQueued(
  threadId: string,
  event: { attempt?: number; dueAtMs?: number; error?: string },
  layer: DataLayer = getDataLayer(),
): void {
  patchRun(
    threadId,
    (prev) => ({
      attempt: event.attempt ?? prev?.attempt ?? 0,
      nextRetryAtMs: event.dueAtMs ?? null,
      lastError: event.error ?? null,
    }),
    layer,
  );
}

export function applyRunReleased(threadId: string, layer: DataLayer = getDataLayer()): void {
  getSchedulerData(layer).remove([threadId]);
}
