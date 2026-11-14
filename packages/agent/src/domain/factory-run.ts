/**
 * The run state machine (#275):
 *
 *   queued → claiming → working → pr_open → waiting_ci ⇄ fixing
 *                                              ↓
 *                                            ready
 *   (queued, claiming, working, waiting_ci, fixing) → failed
 *
 * Merging and retries add their states later.
 */

import { StateMachine } from './state-machine.js';

export type RunState =
  | 'queued'
  | 'claiming'
  | 'working'
  | 'pr_open'
  | 'waiting_ci'
  | 'fixing'
  | 'ready'
  | 'failed';

const TRANSITIONS: Record<RunState, RunState[]> = {
  queued: ['claiming', 'failed'],
  claiming: ['working', 'failed'],
  working: ['pr_open', 'failed'],
  pr_open: ['waiting_ci'],
  waiting_ci: ['fixing', 'ready', 'failed'],
  fixing: ['waiting_ci', 'failed'],
  ready: [],
  failed: [],
};

/**
 * States in which a run holds one of the concurrency slots (a queued run is
 * about to claim). Waiting for CI holds none.
 */
const SLOT_STATES = new Set<string>(['queued', 'claiming', 'working', 'fixing']);
/** States in which an issue has no active run and may be admitted again. */
const ENDED_STATES = new Set<string>(['failed']);

export function runStateMachine(initial: RunState, runId: string): StateMachine<RunState> {
  return new StateMachine(TRANSITIONS, initial, `run ${runId}`);
}

export const holdsSlot = (state: string) => SLOT_STATES.has(state);
export const isActive = (state: string) => !ENDED_STATES.has(state);

/** Fix attempts a run gets before it fails (conflicts included). */
export const MAX_FIX_ATTEMPTS = 3;
