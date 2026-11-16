import { setup } from 'xstate';

import { statusWriteGuards } from './status-transitions.js';
import type { WatcherStatus } from './types.js';

/**
 * Watcher (deferred wake) lifecycle. Enforced by the watcher repository on
 * every status write.
 *
 *   pending ──FIRE──▶ fired ──RESCHEDULE──▶ pending   (the agent snoozes it)
 *   pending ──RESCHEDULE──▶ pending                    (re-armed before it fired)
 *   pending ──EXPIRE──▶ expired                        (deadline or wake budget)
 *   fired ──COMPLETE──▶ done
 *   pending | fired ──CANCEL──▶ cancelled
 *
 * `done`, `cancelled` and `expired` are final: a cancelled watcher is never
 * fired or re-armed; a new one is created instead.
 */
const watcherMachine = setup({
  types: {} as {
    events: { type: 'FIRE' | 'RESCHEDULE' | 'EXPIRE' | 'COMPLETE' | 'CANCEL' };
  },
}).createMachine({
  id: 'watcher',
  initial: 'pending',
  states: {
    pending: {
      on: { FIRE: 'fired', RESCHEDULE: 'pending', EXPIRE: 'expired', CANCEL: 'cancelled' },
    },
    fired: { on: { RESCHEDULE: 'pending', COMPLETE: 'done', CANCEL: 'cancelled' } },
    done: { type: 'final' },
    cancelled: { type: 'final' },
    expired: { type: 'final' },
  },
});

/** The statuses each watcher status may be written from. */
export const WATCHER_STATUS_WRITTEN_FROM = statusWriteGuards<WatcherStatus>(watcherMachine);
