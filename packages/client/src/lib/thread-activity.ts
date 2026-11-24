/**
 * What a thread is doing, as the thread lists show it. A thread's `status`
 * describes only its agent; an issue factory run keeps working after the agent
 * of a step finished (waiting for CI, merging), and waits for the member when it
 * parks. The two state machines stay separate: this derives what to show from
 * both and stores nothing.
 */
import type { ThreadStatus } from '@funny/shared';
import type { FactoryRun } from '@funny/shared/contracts/factory';

import { isFactoryRunFailed, isFactoryRunStoppedAfterFailure } from './factory-run-labels';

export type ThreadActivity =
  /** Nothing beyond the thread's own status. */
  | 'none'
  /** The factory run is working outside the agent (CI, merge, between steps). */
  | 'factory'
  /** The factory run parked waiting for the member. */
  | 'factory-attention'
  /**
   * The factory run's pipeline stopped on an error: failed, parked after one,
   * or stopped by hand after one.
   */
  | 'factory-failed'
  /**
   * The factory run ended without merging and without an error: stopped, or
   * nothing to change. The agent's own "completed" would read as done.
   */
  | 'factory-ended';

/** Factory run states in which its flow drives the run. */
const FACTORY_IN_FLIGHT: ReadonlySet<FactoryRun['state']> = new Set([
  'queued',
  'triaging',
  'working',
  'pr_open',
  'waiting_ci',
  'fixing',
  'reviewing',
  'merging',
]);

/** Thread states in which the agent itself is busy: its own status already says so. */
const AGENT_BUSY: ReadonlySet<ThreadStatus> = new Set([
  'running',
  'setting_up',
  'pending',
  'waiting',
]);

/** Whether a factory run's flow is driving it (not queued, parked or ended). */
export function isFactoryRunInFlight(state: FactoryRun['state']): boolean {
  return FACTORY_IN_FLIGHT.has(state);
}

export function threadActivity(
  thread: { status: ThreadStatus },
  run: Pick<FactoryRun, 'state' | 'failureReason'> | null | undefined,
): ThreadActivity {
  if (!run || AGENT_BUSY.has(thread.status)) return 'none';
  if (isFactoryRunFailed(run) || isFactoryRunStoppedAfterFailure(run)) return 'factory-failed';
  if (run.state === 'waiting_human') return 'factory-attention';
  if (run.state === 'stopped' || run.state === 'no_change') return 'factory-ended';
  return FACTORY_IN_FLIGHT.has(run.state) ? 'factory' : 'none';
}

/** Whether `run`'s issue went into the same factory again as a run started after it. */
export function hasLaterRunOfIssue(
  runs: ReadonlyArray<Pick<FactoryRun, 'id' | 'factoryId' | 'issueNumber' | 'startedAt'>>,
  run: Pick<FactoryRun, 'id' | 'factoryId' | 'issueNumber' | 'startedAt'>,
): boolean {
  return runs.some(
    (other) =>
      other.id !== run.id &&
      other.factoryId === run.factoryId &&
      other.issueNumber === run.issueNumber &&
      other.startedAt > run.startedAt,
  );
}
