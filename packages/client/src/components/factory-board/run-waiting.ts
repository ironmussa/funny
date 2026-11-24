/**
 * Why a run is not moving, in one line, for its board card (openspec
 * factory-pipeline-board): the queue's wait reason, what triage asked, or the
 * reason the server recorded when the run parked or failed.
 */
import type { TFunction } from 'i18next';

import type { FactoryRun } from '@/lib/api/factory';
import {
  factoryRunReasonText,
  factoryWaitReasonText,
  isFactoryRunUnsavedWork,
} from '@/lib/factory-run-labels';

type WaitingRun = Pick<FactoryRun, 'state' | 'waitReason' | 'triage' | 'failureReason'>;

function needsInfoText(t: TFunction, run: WaitingRun): string {
  const triage = run.triage;
  const items = triage?.items?.length ?? 0;
  if (triage?.decision === 'too_big' && items > 0) {
    return t('factoryBoard.waiting.split', 'Triage proposed a split into {{count}} parts', {
      count: items,
    });
  }
  const count = triage?.decision === 'needs_info' ? items : 0;
  return count > 0
    ? t('factoryBoard.waiting.questions', 'Triage asked {{count}} questions on the issue', {
        count,
      })
    : t('factoryBoard.waiting.needsInfo', 'Triage asked on the issue');
}

function doneText(t: TFunction, run: WaitingRun): string | null {
  const parts = run.triage?.splitInto ?? [];
  if (parts.length === 0) return null;
  return t('factoryBoard.waiting.splitInto', 'Split into {{issues}}', {
    issues: parts.map((issue) => `#${issue}`).join(', '),
  });
}

function failedText(t: TFunction, run: WaitingRun): string {
  return run.failureReason
    ? factoryRunReasonText(t, run.failureReason)
    : t('factoryBoard.waiting.failed', 'Failed');
}

function waitingHumanText(t: TFunction, run: WaitingRun): string {
  if (isFactoryRunUnsavedWork(run)) {
    return t('factoryBoard.waiting.unsaved', 'No commit, but unsaved work in its checkout');
  }
  return run.failureReason
    ? factoryRunReasonText(t, run.failureReason)
    : t('factoryBoard.waiting.person', 'Waiting for a person');
}

const WAITING_TEXT: Partial<
  Record<FactoryRun['state'], (t: TFunction, run: WaitingRun) => string | null>
> = {
  requested: (t, run) => (run.waitReason ? factoryWaitReasonText(t, run.waitReason) : null),
  needs_info: needsInfoText,
  done: doneText,
  no_change: (t) =>
    t('factoryBoard.waiting.noChange', 'Nothing to change: the issue needs a person'),
  failed: failedText,
  waiting_human: waitingHumanText,
};

export function factoryRunWaitingText(t: TFunction, run: WaitingRun): string | null {
  return WAITING_TEXT[run.state]?.(t, run) ?? null;
}
