/**
 * The run state machine (#275):
 *
 *   queued → claiming → working → pr_open → waiting_ci ⇄ fixing
 *                                              ↓
 *                                    ready | merging → merged
 *   (queued, claiming, working, waiting_ci, fixing) → failed
 *   (claiming, working) → queued       an infrastructure failure, retried later
 *   fixing → waiting_ci                 also after an infrastructure failure
 *   merging → waiting_ci                the pull request turned red while it waited to merge
 *   (ready, merging) → failed           the pull request was closed without merging
 *   waiting_ci → merged                 a person merged it (seen on a restart)
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
  | 'merging'
  | 'merged'
  | 'failed';

const TRANSITIONS: Record<RunState, RunState[]> = {
  queued: ['claiming', 'failed'],
  claiming: ['working', 'queued', 'failed'],
  working: ['pr_open', 'queued', 'failed'],
  pr_open: ['waiting_ci'],
  waiting_ci: ['fixing', 'ready', 'merging', 'merged', 'failed'],
  fixing: ['waiting_ci', 'failed'],
  ready: ['merged', 'failed'],
  merging: ['merged', 'waiting_ci', 'failed'],
  merged: [],
  failed: [],
};

/**
 * States in which a run holds one of the concurrency slots (a queued run is
 * about to claim). Waiting for CI holds none.
 */
const SLOT_STATES = new Set<string>(['queued', 'claiming', 'working', 'fixing']);
/** States in which a factory run has ended (a merged issue is closed and never listed ready). */
const ENDED_STATES = new Set<string>(['failed', 'merged']);

export function runStateMachine(initial: RunState, runId: string): StateMachine<RunState> {
  return new StateMachine(TRANSITIONS, initial, `run ${runId}`);
}

/**
 * Whether a run holds a concurrency slot. A run waiting to retry (queued with
 * a not-before time) takes one only when it starts again.
 */
export const holdsSlot = (run: { state: string; notBefore?: string }) =>
  SLOT_STATES.has(run.state) && !(run.state === 'queued' && run.notBefore);

/** A failed run whose issue still has to be handed back. */
export const needsHandBack = (run: { state: string; handedBackAt?: string }) =>
  run.state === 'failed' && !run.handedBackAt;
/**
 * Whether a run keeps its issue from being admitted again: while it is active,
 * and once failed until its issue has been handed back (labels reset).
 */
export const blocksAdmission = (run: { state: string; handedBackAt?: string }) =>
  !ENDED_STATES.has(run.state) || needsHandBack(run);

/** Fix attempts a run gets before it fails (conflicts included). */
export const MAX_FIX_ATTEMPTS = 3;
