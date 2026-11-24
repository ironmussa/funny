/**
 * A factory run's actions: open its pull request, and the member's controls
 * (retry a failed or parked run, approve merging a high-risk change the
 * factory held, stop one that has not ended). Shared by the
 * project's run list, the footer indicator's popover and the failure card in
 * the thread. Renders the buttons only; the caller lays them out.
 */
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { controlFactoryRun } from '@/data/factory/actions';
import { useCanSteerProject } from '@/data/projects/hooks';
import type { FactoryRun } from '@/lib/api/factory';
import { ENDED_FACTORY_STATES, isFactoryRunAwaitingMergeApproval } from '@/lib/factory-run-labels';
import { toastError } from '@/lib/toast-error';

/** A run parked on its issue (`needs_info`) is triaged again by a retry. */
const RETRYABLE = new Set<FactoryRun['state']>([
  'failed',
  'waiting_human',
  'no_change',
  'needs_info',
]);

export function FactoryRunControls({
  projectId,
  run,
  testId,
  children,
}: {
  projectId: string;
  run: FactoryRun;
  /** The buttons' test ids, so several copies on one page stay apart. */
  testId: (button: 'pr' | 'retry' | 'stop' | 'approve-merge') => string;
  /** More links, between the pull request and the controls. */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const canSteer = useCanSteerProject(projectId);
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  const control = (action: 'stop' | 'retry' | 'approve-merge') =>
    void controlFactoryRun(action, projectId, run.id).orTee((error) =>
      toastError(error, 'factory'),
    );
  // A high-risk change waits for the member's approval, which a retry would not give.
  const awaitsApproval = isFactoryRunAwaitingMergeApproval(run);

  return (
    <>
      {run.prUrl && (
        <Button asChild size="xs" variant="link" data-testid={testId('pr')}>
          <a href={run.prUrl} target="_blank" rel="noreferrer">
            {awaitsApproval
              ? t('factory.viewPullRequest', 'View PR')
              : t('factory.pullRequest', 'PR')}
          </a>
        </Button>
      )}
      {children}
      {canSteer && awaitsApproval && (
        <>
          <Button
            size="xs"
            data-testid={testId('approve-merge')}
            onClick={() => setConfirmingMerge(true)}
          >
            {t('factory.approveMerge', 'Approve and merge')}
          </Button>
          <ConfirmDialog
            open={confirmingMerge}
            onOpenChange={setConfirmingMerge}
            title={t('factory.approveMergeTitle', 'Merge this high-risk change?')}
            description={t(
              'factory.approveMergeBody',
              'The factory will merge commit {{sha}} of issue #{{issue}} once its checks, review and regression proof still pass. A new commit on the branch needs a new approval.',
              { sha: run.risk?.headSha.slice(0, 7) ?? '', issue: run.issueNumber },
            )}
            warning={run.risk?.reasons.join('; ')}
            confirmLabel={t('factory.approveMerge', 'Approve and merge')}
            cancelLabel={t('common.cancel', 'Cancel')}
            variant="default"
            onCancel={() => setConfirmingMerge(false)}
            onConfirm={() => {
              setConfirmingMerge(false);
              control('approve-merge');
            }}
          />
        </>
      )}
      {canSteer && RETRYABLE.has(run.state) && !awaitsApproval && (
        <Button
          size="xs"
          variant="outline"
          data-testid={testId('retry')}
          onClick={() => control('retry')}
        >
          {t('factory.retry', 'Retry')}
        </Button>
      )}
      {canSteer && !ENDED_FACTORY_STATES.has(run.state) && (
        <Button
          size="xs"
          variant="ghost"
          data-testid={testId('stop')}
          onClick={() => control('stop')}
        >
          {t('factory.stop', 'Stop')}
        </Button>
      )}
    </>
  );
}
