import { setup } from 'xstate';

import { statusWriteGuards } from './status-transitions.js';
import type { ActivityStatus } from './types.js';

/** The events the machine accepts. */
interface ActivityMachineTypes {
  events: { type: 'STEP' | 'SUCCEED' | 'FAIL' | 'INTERRUPT' };
}

/**
 * Background activity lifecycle (track-background-activities, design D2).
 * Enforced by the activity repository on every status write.
 *
 *   running     ──SUCCEED──▶ succeeded
 *   running     ──FAIL──▶    failed
 *   running     ──INTERRUPT──▶ interrupted  (its runner reconnected without it)
 *   running     ──STEP──▶    running        (a new step is recorded)
 *   interrupted ──SUCCEED──▶ succeeded      (a late terminal report still lands)
 *   interrupted ──FAIL──▶    failed
 *
 * `succeeded` and `failed` are final: the first terminal writer wins.
 */
const activityMachine = setup({
  types: {} as ActivityMachineTypes,
}).createMachine({
  id: 'activity',
  initial: 'running',
  states: {
    running: {
      on: { STEP: 'running', SUCCEED: 'succeeded', FAIL: 'failed', INTERRUPT: 'interrupted' },
    },
    interrupted: { on: { SUCCEED: 'succeeded', FAIL: 'failed' } },
    succeeded: { type: 'final' },
    failed: { type: 'final' },
  },
});

/** The statuses each activity status may be written from. */
export const ACTIVITY_STATUS_WRITTEN_FROM = statusWriteGuards<ActivityStatus>(activityMachine);

/** Whether an activity may move from `from` to `to`. */
export function nextActivityStatus(from: ActivityStatus, to: ActivityStatus): boolean {
  return ACTIVITY_STATUS_WRITTEN_FROM[to]?.includes(from) ?? false;
}

/** A status no report can leave. */
export function isFinalActivityStatus(status: ActivityStatus): boolean {
  return status === 'succeeded' || status === 'failed';
}
