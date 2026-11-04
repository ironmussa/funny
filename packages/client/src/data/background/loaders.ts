import type { Job, Watcher } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { okAsync, ResultAsync } from 'neverthrow';

import { jobsApi } from '@/lib/api/jobs';
import { watchersApi } from '@/lib/api/watchers';
import { createClientLogger } from '@/lib/client-logger';

import type { DataLayer } from '../data-layer';
import type { EntityStore } from '../entities';
import { toDomainError, unwrapResult } from '../query-client';
import { getDataLayer } from '../runtime';
import { getJobsData, getWatchersData } from './store';

const log = createClientLogger('background-activity');

/** Load a complete list into its collection; concurrent loads share one request. */
function loadList<T extends { id: string }>(
  layer: DataLayer,
  name: string,
  data: EntityStore<T>,
  fetchList: () => ResultAsync<T[], DomainError>,
): ResultAsync<T[] | null, DomainError> {
  // Realtime events can arrive while logging in or out; skip without a session.
  if (!layer.userId) return okAsync(null);
  return ResultAsync.fromPromise(
    layer.queryClient.fetchQuery({
      queryKey: [name],
      staleTime: 0,
      queryFn: async () => {
        const rows = await unwrapResult(fetchList());
        data.replaceAll(rows);
        return rows;
      },
    }),
    toDomainError,
  ).mapErr((error) => {
    log.warn(`failed to load ${name}`, { error: error.message });
    return error;
  });
}

export function loadJobs(
  layer: DataLayer = getDataLayer(),
): ResultAsync<Job[] | null, DomainError> {
  return loadList(layer, 'jobs', getJobsData(layer), jobsApi.listJobs);
}

export function loadWatchers(
  layer: DataLayer = getDataLayer(),
): ResultAsync<Watcher[] | null, DomainError> {
  return loadList(layer, 'watchers', getWatchersData(layer), watchersApi.listWatchers);
}

/** Realtime `job:*` event: the authoritative row. */
export function applyJobEvent(job: Job, layer: DataLayer = getDataLayer()): void {
  getJobsData(layer).upsert([job]);
}

/** Realtime `watcher:*` event: the authoritative row. */
export function applyWatcherEvent(watcher: Watcher, layer: DataLayer = getDataLayer()): void {
  getWatchersData(layer).upsert([watcher]);
}
