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

export function factoryRunWaitingText(
  t: TFunction,
  run: Pick<FactoryRun, 'state' | 'waitReason' | 'triage' | 'failureReason'>,
): string | null {
  switch (run.state) {
    case 'requested':
      return run.waitReason ? factoryWaitReasonText(t, run.waitReason) : null;
    case 'needs_info': {
      if (run.triage?.decision === 'too_big' && (run.triage.items?.length ?? 0) > 0) {
        return t('factoryBoard.waiting.split', 'Triage proposed a split into {{count}} parts', {
          count: run.triage.items?.length ?? 0,
        });
      }
      const count = run.triage?.decision === 'needs_info' ? (run.triage.items?.length ?? 0) : 0;
      return count > 0
        ? t('factoryBoard.waiting.questions', 'Triage asked {{count}} questions on the issue', {
            count,
          })
        : t('factoryBoard.waiting.needsInfo', 'Triage asked on the issue');
    }
    case 'done': {
      const parts = run.triage?.splitInto ?? [];
      return parts.length > 0
        ? t('factoryBoard.waiting.splitInto', 'Split into {{issues}}', {
            issues: parts.map((issue) => `#${issue}`).join(', '),
          })
        : null;
    }
    case 'no_change':
      return t('factoryBoard.waiting.noChange', 'Nothing to change: the issue needs a person');
    case 'failed':
      return run.failureReason
        ? factoryRunReasonText(t, run.failureReason)
        : t('factoryBoard.waiting.failed', 'Failed');
    case 'waiting_human':
      if (isFactoryRunUnsavedWork(run)) {
        return t('factoryBoard.waiting.unsaved', 'No commit, but unsaved work in its checkout');
      }
      return run.failureReason
        ? factoryRunReasonText(t, run.failureReason)
        : t('factoryBoard.waiting.person', 'Waiting for a person');
    default:
      return null;
  }
}
