import type { Activity } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { ownEntityStore, type EntityStore } from '../entities';
import { getDataLayer } from '../runtime';

/**
 * Background activities the user started (clone, worktree setup, git
 * workflow): a collection fed by `activities.list` and the `activity:*`
 * realtime events. Progress percentages are transient and live in their own
 * collection, next to the rows, so a progress tick never rewrites a row.
 */

export interface ActivityProgress {
  id: string;
  percent: number;
}

export function getActivitiesData(layer: DataLayer = getDataLayer()): EntityStore<Activity> {
  return ownEntityStore<Activity>(layer, 'activities');
}

export function getActivityProgressData(
  layer: DataLayer = getDataLayer(),
): EntityStore<ActivityProgress> {
  return ownEntityStore<ActivityProgress>(layer, 'activity-progress');
}
