import type { GitStatusInfo } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import type { EntityStore } from '../entities';
import { getDataLayer } from '../runtime';
import type { GitStatusMaps, ProjectGitStatus } from './keys';
import { getGitStatusData } from './store';

/** Imperative reads of git status, for event handlers and store actions. */

type WithId = { id: string };
const plainCopies = new WeakMap<object, unknown>();

/** A row without its collection key (the `id` the collections need). */
export function withoutId<T extends WithId>(row: T): Omit<T, 'id'> {
  const cached = plainCopies.get(row);
  if (cached) return cached as Omit<T, 'id'>;
  const { id: _id, ...rest } = row;
  plainCopies.set(row, rest);
  return rest;
}

function recordOf<T extends WithId, V>(
  store: EntityStore<T>,
  value: (row: T) => V,
): Record<string, V> {
  const out: Record<string, V> = {};
  for (const row of store.collection.values()) out[row.id] = value(store.fromRow(row));
  return out;
}

export function readGitStatusMaps(layer: DataLayer = getDataLayer()): GitStatusMaps {
  const data = getGitStatusData(layer);
  return {
    statusByBranch: recordOf(data.statuses, (row) => withoutId(row) as GitStatusInfo),
    threadToBranchKey: recordOf(data.threadKeys, (row) => row.branchKey),
  };
}

export function readProjectGitStatus(
  projectId: string,
  layer: DataLayer = getDataLayer(),
): ProjectGitStatus | undefined {
  const row = getGitStatusData(layer).projects.read(projectId);
  return row ? withoutId(row) : undefined;
}
