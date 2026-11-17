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
