import type { DomainError } from '@funny/shared/errors';
import { errAsync, type ResultAsync } from 'neverthrow';

import { jobsApi } from '@/lib/api/jobs';
import { watchersApi } from '@/lib/api/watchers';

import type { DataLayer } from '../data-layer';
import { optimisticWrite } from '../optimistic-write';
import { getDataLayer } from '../runtime';
import { getJobsData, getWatchersData } from './store';

/** Cancels show as `cancelled` at once and roll back with a toast if the server refuses. */

const FAILURE_KEY = 'errors.backgroundCancelFailed';

function missing(kind: string, id: string): ResultAsync<never, DomainError> {
  return errAsync({ type: 'NOT_FOUND', message: `${kind} ${id} is not loaded` });
}

export function cancelJob(
  jobId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<unknown, DomainError> {
  const data = getJobsData(layer);
  if (!data.collection.has(jobId)) return missing('Job', jobId);
  return optimisticWrite({
    entity: 'jobs',
    operation: 'cancel',
    apply: () =>
      data.collection.update(jobId, (draft) => {
        draft.status = 'cancelled';
      }),
    persist: () => jobsApi.cancelJob(jobId),
    // The runner follows with job:cancelled carrying the authoritative row;
    // until then keep the confirmed cancel instead of flicking back to running.
    confirm: () => data.patch(jobId, (row) => ({ ...row, status: 'cancelled' })),
    failureMessageKey: FAILURE_KEY,
  });
}

export function cancelWatcher(
  watcherId: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<unknown, DomainError> {
  const data = getWatchersData(layer);
  if (!data.collection.has(watcherId)) return missing('Watcher', watcherId);
  return optimisticWrite({
    entity: 'watchers',
    operation: 'cancel',
    apply: () =>
      data.collection.update(watcherId, (draft) => {
        draft.status = 'cancelled';
      }),
    persist: () => watchersApi.cancelWatcher(watcherId),
    confirm: (updated) => data.upsert([updated]),
    failureMessageKey: FAILURE_KEY,
  });
}
