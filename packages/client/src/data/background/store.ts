import type { Job, Watcher } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { ownEntityStore, type EntityStore } from '../entities';
import { getDataLayer } from '../runtime';

/**
 * Background activity the user owns across threads: jobs (`funny_spawn`
 * processes) and watchers (`funny_watch` snoozes). Each is a collection fed by
 * its list endpoint and by the `job:*` / `watcher:*` realtime events.
 */

export function getJobsData(layer: DataLayer = getDataLayer()): EntityStore<Job> {
  return ownEntityStore<Job>(layer, 'jobs');
}

export function getWatchersData(layer: DataLayer = getDataLayer()): EntityStore<Watcher> {
  return ownEntityStore<Watcher>(layer, 'watchers');
}
