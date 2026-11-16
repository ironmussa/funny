import { setup } from 'xstate';

import { statusWriteGuards } from './status-transitions.js';
import type { JobStatus } from './types.js';

/**
 * Background job lifecycle. Enforced by the job repository on every status
 * write.
 *
 *   running ──EXIT──▶ exited      (exit code 0)
 *   running ──FAIL──▶ failed      (non-zero exit code)
 *   running ──KILL──▶ killed      (the process is gone without an exit marker)
 *   running ──CANCEL──▶ cancelled (the user cancelled it)
 *   running ──SPAWNED──▶ running  (its pid is recorded)
 *
 * Every other status is final: the first writer wins, so a cancel is not
 * overwritten by the scanner and a finished job cannot be cancelled.
 */
const jobMachine = setup({
  types: {} as { events: { type: 'SPAWNED' | 'EXIT' | 'FAIL' | 'KILL' | 'CANCEL' } },
}).createMachine({
  id: 'job',
  initial: 'running',
  states: {
    running: {
      on: {
        SPAWNED: 'running',
        EXIT: 'exited',
        FAIL: 'failed',
        KILL: 'killed',
        CANCEL: 'cancelled',
      },
    },
    exited: { type: 'final' },
    failed: { type: 'final' },
    killed: { type: 'final' },
    cancelled: { type: 'final' },
  },
});

/** The statuses each job status may be written from. */
export const JOB_STATUS_WRITTEN_FROM = statusWriteGuards<JobStatus>(jobMachine);
