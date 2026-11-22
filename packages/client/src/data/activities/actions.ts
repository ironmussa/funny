import type { Activity } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { errAsync, type ResultAsync } from 'neverthrow';

import { activitiesApi } from '@/lib/api/activities';
import { gitApi } from '@/lib/api/git';

import type { DataLayer } from '../data-layer';
import { optimisticWrite } from '../optimistic-write';
import { getDataLayer } from '../runtime';
import { getActivitiesData } from './store';

/** Dismiss and clear hide rows at once and roll back with a toast if the server refuses. */

const FAILURE_KEY = 'errors.activityDismissFailed';

export function dismissActivity(
  id: string,
  layer: DataLayer = getDataLayer(),
): ResultAsync<unknown, DomainError> {
  const data = getActivitiesData(layer);
  if (!data.collection.has(id)) {
    return errAsync({ type: 'NOT_FOUND', message: `Activity ${id} is not loaded` });
  }
  return optimisticWrite({
    entity: 'activities',
    operation: 'dismiss',
    apply: () => data.collection.delete(id),
    persist: () => activitiesApi.dismissActivity(id),
    confirm: (removed) => data.remove(removed.ids),
    failureMessageKey: FAILURE_KEY,
  });
}

export function clearFinishedActivities(
  layer: DataLayer = getDataLayer(),
): ResultAsync<unknown, DomainError> {
  const data = getActivitiesData(layer);
  const finished = data.collection.toArray
    .filter((row) => row.status !== 'running')
    .map((row) => row.id);
  return optimisticWrite({
    entity: 'activities',
    operation: 'clear-finished',
    apply: () => {
      if (finished.length > 0) data.collection.delete(finished);
    },
    persist: () => activitiesApi.clearFinishedActivities(),
    confirm: (removed) => data.remove(removed.ids),
    failureMessageKey: FAILURE_KEY,
  });
}

/**
 * Put back what a destructive git command removed (track-user-and-scheduled-
 * actions, design D6), on the thread's worktree or the project checkout it ran
 * on. The runner saves the current state first and records the restore as its
 * own activity, which arrives over the realtime channel. Fails with
 * NOT_FOUND `snapshot-gone` when the snapshot was pruned.
 */
export function restoreActivitySnapshot(activity: Activity): ResultAsync<unknown, DomainError> {
  if (activity.threadId) return gitApi.restoreSnapshot(activity.threadId, activity.id);
  if (activity.projectId) return gitApi.projectRestoreSnapshot(activity.projectId, activity.id);
  return errAsync({ type: 'BAD_REQUEST', message: 'The activity has no workspace to restore' });
}
