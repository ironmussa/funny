import type { ThreadStatus } from '@funny/shared';
import type { FactoryRun } from '@funny/shared/contracts/factory';
import type { TFunction } from 'i18next';

import { useActiveFactoryRunForThread } from '@/data/factory/hooks';
import {
  factoryRunFailedStep,
  factoryRunStateLabel,
  isFactoryRunStoppedAfterFailure,
  factoryRunBanner,
} from '@/lib/factory-run-labels';
import { threadActivity, type ThreadActivity } from '@/lib/thread-activity';

export interface ThreadActivityView {
  activity: ThreadActivity;
  /** The factory run behind the activity; null when `activity` is `none`. */
  run: FactoryRun | null;
  /** The run's issue went into the factory again as a later run. */
  resent: boolean;
}

/** What a thread row shows beyond its own status (see `lib/thread-activity.ts`). */
export function useThreadActivity(thread: {
  id: string;
  status: ThreadStatus;
  source?: string;
}): ThreadActivityView {
  const found = useActiveFactoryRunForThread(thread);
  const activity = threadActivity(thread, found?.run);
  if (activity === 'none' || !found) return { activity, run: null, resent: false };
  return { activity, run: found.run, resent: found.resent };
}

/** The short label a row shows in place of its time: the run's step, else its state. */
export function threadActivityShortLabel(t: TFunction, view: ThreadActivityView): string | null {
  // A failed run keeps the row's time: the error icon says what happened.
  if (!view.run || view.activity === 'factory-failed') return null;
  if (view.activity === 'factory-attention' || view.activity === 'factory-ended') {
    return factoryRunStateLabel(t, view.run.state);
  }
  return view.run.currentStep ?? factoryRunStateLabel(t, view.run.state);
}

/** The tooltip of a row's activity (a run without an issue shows its schedule's name): "Factory · #225 · Waiting for CI". */
export function threadActivityTooltip(t: TFunction, view: ThreadActivityView): string | null {
  if (!view.run) return null;
  const label = activityTooltipText(t, view.run, view.activity);
  if (!view.resent) return label;
  return t('factory.activity.resentTooltip', '{{label}} · Sent again as a new run', { label });
}

function activityTooltipText(t: TFunction, run: FactoryRun, activity: ThreadActivity): string {
  const subject = factoryRunBanner(t, run);
  if (isFactoryRunStoppedAfterFailure(run)) {
    return run.currentStep
      ? t('factory.activity.stoppedAfterFailure', '{{run}} · Stopped after failing at {{step}}', {
          run: subject,
          step: run.currentStep,
        })
      : t('factory.activity.stoppedWithReason', '{{run}} · Stopped: {{reason}}', {
          run: subject,
          reason: run.failureReason,
        });
  }
  const failedStep = activity === 'factory-failed' ? factoryRunFailedStep(run) : null;
  if (failedStep) {
    return t('factory.activity.failedAt', '{{run}} · Failed at {{step}}', {
      run: subject,
      step: failedStep,
    });
  }
  return `${subject} · ${factoryRunStateLabel(t, run.state)}`;
}
