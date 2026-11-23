import type { Activity } from '@funny/shared';

import type { DataLayer } from '../data-layer';
import { getDataLayer } from '../runtime';
import { getActivitiesData, getActivityProgressData, type ActivityProgress } from './store';

/** Make `activities` the session's complete list (tests, stories). */
export function seedActivities(
  activities: readonly Activity[],
  { progress = [] }: { progress?: readonly ActivityProgress[] } = {},
  layer: DataLayer = getDataLayer(),
): void {
  getActivitiesData(layer).replaceAll(activities);
  getActivityProgressData(layer).replaceAll(progress);
}

/** A complete activity row with sensible defaults (tests, stories). */
export function buildActivity(overrides: Partial<Activity> = {}): Activity {
  return {
    id: 'a1',
    userId: 'u1',
    runnerId: 'r1',
    kind: 'project.clone',
    projectId: null,
    threadId: null,
    title: 'Clone acme/widget',
    status: 'running',
    step: null,
    error: null,
    input: { cloneUrl: 'https://github.com/acme/widget.git', destinationPath: '/home/me/code' },
    resultRef: null,
    origin: 'user',
    effects: null,
    startedAt: '2026-11-20T10:00:00.000Z',
    endedAt: null,
    ...overrides,
  };
}
