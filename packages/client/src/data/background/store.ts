import type { Job, Watcher } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { createEntityStore, type EntityStore } from '../entities';
import { getDataLayer } from '../runtime';

/**
 * Background activity the user owns across threads: jobs (`funny_spawn`
 * processes) and watchers (`funny_watch` snoozes). Each is a collection fed by
 * its list endpoint and by the `job:*` / `watcher:*` realtime events.
 */

function own<T extends { id: string }>(layer: DataLayer, name: string): EntityStore<T> {
  return layer.own(name, () => {
    const data = createEntityStore<T>(layer, name);
    return {
      value: data,
      dispose: () => void data.collection.cleanup({ dependents: true }).catch(() => undefined),
    };
  });
}

export function getJobsData(layer: DataLayer = getDataLayer()): EntityStore<Job> {
  return own<Job>(layer, 'jobs');
}

export function getWatchersData(layer: DataLayer = getDataLayer()): EntityStore<Watcher> {
  return own<Watcher>(layer, 'watchers');
}
