import type { Job, Watcher } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { getJobsData, getWatchersData } from './store';

/** Make `jobs` / `watchers` the session's complete lists (tests). */
export function seedBackgroundActivity(
  { jobs = [], watchers = [] }: { jobs?: readonly Job[]; watchers?: readonly Watcher[] },
  layer: DataLayer = getDataLayer(),
): void {
  getJobsData(layer).replaceAll(jobs);
  getWatchersData(layer).replaceAll(watchers);
}
