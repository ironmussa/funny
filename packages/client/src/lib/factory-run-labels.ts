/**
 * How a factory run reads in the UI (change issue-factory, factory-manual-queue):
 * the state's label and badge variant, and why a queued issue waits. Shared by
 * the project's factory runs list and the Issues tab.
 */
import type { TFunction } from 'i18next';

import type { FactoryRun, FactoryWaitReason } from '@/lib/api/factory';

/** States a run no longer moves out of by itself. */
export const ENDED_FACTORY_STATES: ReadonlySet<FactoryRun['state']> = new Set([
  'merged',
  'failed',
  'stopped',
]);

export function factoryRunStateLabel(t: TFunction, state: FactoryRun['state']): string {
  const labels: Record<FactoryRun['state'], string> = {
    requested: t('factory.state.requested', 'In queue'),
    queued: t('factory.state.queued', 'Queued'),
    working: t('factory.state.working', 'Working'),
    pr_open: t('factory.state.prOpen', 'PR open'),
    waiting_ci: t('factory.state.waitingCi', 'Waiting for CI'),
    fixing: t('factory.state.fixing', 'Fixing CI'),
    waiting_human: t('factory.state.waitingHuman', 'Waiting for you'),
    merged: t('factory.state.merged', 'Merged'),
    failed: t('factory.state.failed', 'Failed'),
    stopped: t('factory.state.stopped', 'Stopped'),
  };
  return labels[state];
}

export function factoryRunStateVariant(state: FactoryRun['state']) {
  if (state === 'waiting_human') return 'default' as const;
  if (state === 'failed') return 'destructive' as const;
  return ENDED_FACTORY_STATES.has(state) ? ('outline' as const) : ('secondary' as const);
}

const issues = (numbers: number[]) => numbers.map((n) => `#${n}`).join(', ');

/** Why a queued issue is not admitted yet. */
export function factoryWaitReasonText(t: TFunction, reason: FactoryWaitReason): string {
  const blockers = issues(reason.blockers);
  switch (reason.kind) {
    case 'blocker-not-sent':
      return t('factory.wait.notSent', 'Blocked by {{blockers}}, which is not in the factory', {
        blockers,
      });
    case 'blocker-in-progress':
      return t('factory.wait.inProgress', 'Waiting for {{blockers}} to finish', { blockers });
    case 'blocker-waiting-merge':
      return t('factory.wait.waitingMerge', 'Waiting for the pull request of {{blockers}}', {
        blockers,
      });
    case 'blocker-failed':
      return t('factory.wait.failed', 'Blocked by {{blockers}}, whose run failed or was stopped', {
        blockers,
      });
    case 'blocker-other-repo':
      return t('factory.wait.otherRepo', 'Blocked by {{blockers}} in another repository', {
        blockers,
      });
    case 'circular':
      return t('factory.wait.circular', 'Circular dependency with {{blockers}}', { blockers });
    case 'blockers-unreadable':
      return t('factory.wait.unreadable', 'Its blockers could not be read from GitHub');
  }
}

export type FactoryStepStatus = 'done' | 'current' | 'failed' | 'pending';

/** States a flow is moving through a step in. */
const MOVING: ReadonlySet<FactoryRun['state']> = new Set([
  'queued',
  'working',
  'pr_open',
  'waiting_ci',
  'fixing',
]);

/**
 * Whether the run's pipeline stopped on an error: it failed, or it waits for
 * the member after a failure (the flow's `on_failure` parked it).
 */
export function isFactoryRunFailed(run: Pick<FactoryRun, 'state' | 'failureReason'>): boolean {
  return run.state === 'failed' || (run.state === 'waiting_human' && run.failureReason !== null);
}

/** The step the run failed at, when it failed at one. */
export function factoryRunFailedStep(
  run: Pick<FactoryRun, 'state' | 'currentStep' | 'flowSteps' | 'failureReason'>,
): string | null {
  return factoryRunSteps(run).find((step) => step.status === 'failed')?.name ?? null;
}

/**
 * Each step of the run's flow, with how far the run got: the steps before the
 * current one are done; the current one is in progress, or failed when the
 * run failed (or waits for the member after a failure) there. A run whose flow
 * ended without a current step (merged, or parked with its PR ready) has done
 * them all. Older runs recorded no steps: only the current one is known.
 */
export function factoryRunSteps(
  run: Pick<FactoryRun, 'state' | 'currentStep' | 'flowSteps' | 'failureReason'>,
): Array<{ name: string; status: FactoryStepStatus }> {
  const names = run.flowSteps.length > 0 ? run.flowSteps : run.currentStep ? [run.currentStep] : [];
  const at = run.currentStep ? names.indexOf(run.currentStep) : -1;
  const flowEnded = run.state === 'merged' || (run.state === 'waiting_human' && at === -1);
  const failedHere = isFactoryRunFailed(run);
  return names.map((name, index) => {
    if (flowEnded) return { name, status: 'done' };
    if (at === -1 || index > at) return { name, status: 'pending' };
    if (index < at) return { name, status: 'done' };
    if (failedHere) return { name, status: 'failed' };
    return { name, status: MOVING.has(run.state) ? 'current' : 'pending' };
  });
}
