/**
 * The run state machine (#275):
 *
 *   queued → claiming → working → pr_open → …
 *                    ↘ failed ↙
 *
 * Only the states this change reaches are listed; CI follow-up, merging and
 * retries add theirs later.
 */

import { StateMachine } from './state-machine.js';

export type RunState = 'queued' | 'claiming' | 'working' | 'pr_open' | 'failed';

const TRANSITIONS: Record<RunState, RunState[]> = {
  queued: ['claiming', 'failed'],
  claiming: ['working', 'failed'],
  working: ['pr_open', 'failed'],
  pr_open: [],
  failed: [],
};

/** States in which a run holds one of the concurrency slots (a queued run is about to claim). */
const SLOT_STATES = new Set<string>(['queued', 'claiming', 'working']);
/** States in which an issue has no active run and may be admitted again. */
const ENDED_STATES = new Set<string>(['failed']);

export function runStateMachine(initial: RunState, runId: string): StateMachine<RunState> {
  return new StateMachine(TRANSITIONS, initial, `run ${runId}`);
}

export const holdsSlot = (state: string) => SLOT_STATES.has(state);
export const isActive = (state: string) => !ENDED_STATES.has(state);
