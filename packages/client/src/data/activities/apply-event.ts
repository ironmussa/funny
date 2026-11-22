import type {
  Activity,
  WSActivityProgressData,
  WSActivityRemovedData,
  WSActivityUpdatedData,
} from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { getActivitiesData, getActivityProgressData } from './store';

/** What applying an `activity:updated` event changed, for the caller's notifications. */
export interface ActivityUpdateOutcome {
  activity: Activity;
  /** The row moved to `failed` with this event (not: was already failed, or a list load). */
  becameFailed: boolean;
  /**
   * The project a clone created, when the row moved to `succeeded` with this
   * event. The clone screen that started it may be long closed, so the caller
   * reloads the project list itself.
   */
  createdProjectId: string | null;
}

/** Realtime `activity:updated`: the authoritative row replaces the stored one. */
export function applyActivityUpdated(
  data: WSActivityUpdatedData | undefined,
  layer: DataLayer = getDataLayer(),
): ActivityUpdateOutcome | null {
  const activity = data?.activity;
  if (!activity?.id) return null;
  const store = getActivitiesData(layer);
  const previous = store.getSynced(activity.id);
  store.upsert([activity]);
  if (activity.status !== 'running') getActivityProgressData(layer).remove([activity.id]);
  const becameSucceeded = activity.status === 'succeeded' && previous?.status !== 'succeeded';
  return {
    activity,
    becameFailed: activity.status === 'failed' && previous?.status !== 'failed',
    createdProjectId:
      becameSucceeded && activity.kind === 'project.clone'
        ? (activity.resultRef?.projectId ?? null)
        : null,
  };
}

/** Realtime `activity:removed`: another tab (or this one) deleted rows. */
export function applyActivitiesRemoved(
  data: WSActivityRemovedData | undefined,
  layer: DataLayer = getDataLayer(),
): void {
  const ids = data?.ids ?? [];
  if (ids.length === 0) return;
  getActivitiesData(layer).remove(ids);
  getActivityProgressData(layer).remove(ids);
}

/** Realtime `activity:progress`: transient; ignored for a row that is not running here. */
export function applyActivityProgress(
  data: WSActivityProgressData | undefined,
  layer: DataLayer = getDataLayer(),
): void {
  if (!data?.id || !Number.isFinite(data.percent)) return;
  const row = getActivitiesData(layer).getSynced(data.id);
  if (row?.status !== 'running') return;
  getActivityProgressData(layer).upsert([{ id: data.id, percent: data.percent }]);
}
