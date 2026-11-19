import type { ThreadStatus } from '@funny/shared';
import type { FactoryRun } from '@funny/shared/contracts/factory';
import type { TFunction } from 'i18next';

import { useActiveFactoryRunForThread } from '@/data/factory/hooks';
import { factoryRunStateLabel } from '@/lib/factory-run-labels';
import { threadActivity, type ThreadActivity } from '@/lib/thread-activity';

export interface ThreadActivityView {
  activity: ThreadActivity;
  /** The factory run behind the activity; null when `activity` is `none`. */
  run: FactoryRun | null;
}

/** What a thread row shows beyond its own status (see `lib/thread-activity.ts`). */
export function useThreadActivity(thread: {
  id: string;
  status: ThreadStatus;
  source?: string;
}): ThreadActivityView {
  const run = useActiveFactoryRunForThread(thread);
  const activity = threadActivity(thread, run);
  return { activity, run: activity === 'none' ? null : run };
}

/** The short label a row shows in place of its time: the run's step, else its state. */
export function threadActivityShortLabel(t: TFunction, view: ThreadActivityView): string | null {
  if (!view.run) return null;
  if (view.activity === 'factory-attention') return factoryRunStateLabel(t, view.run.state);
  return view.run.currentStep ?? factoryRunStateLabel(t, view.run.state);
}

/** The tooltip of a row's activity: "Factory · #225 · Waiting for CI". */
export function threadActivityTooltip(t: TFunction, view: ThreadActivityView): string | null {
  if (!view.run) return null;
  return t('factory.activity.tooltip', 'Factory · #{{issue}} · {{state}}', {
    issue: view.run.issueNumber,
    state: factoryRunStateLabel(t, view.run.state),
  });
}
