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
import { PRBadge } from '@/components/PRBadge';
import { Button } from '@/components/ui/button';
import {
  approveFactoryMerge,
  controlFactoryRun,
  setFactoryRunLintCleanup,
} from '@/data/factory/actions';
import { useCanSteerProject } from '@/data/projects/hooks';
import type { FactoryRun } from '@/lib/api/factory';
import { ENDED_FACTORY_STATES, isFactoryRunAwaitingMergeApproval } from '@/lib/factory-run-labels';
import { toastError } from '@/lib/toast-error';

/** The number of a GitHub pull request URL, or null. */
export function pullRequestNumber(url: string): number | null {
  const match = url.match(/\/pull\/(\d+)/)?.[1];
  return match ? Number(match) : null;
}

/** A run parked on its issue (`needs_info`) is triaged again by a retry. */
const RETRYABLE = new Set<FactoryRun['state']>([
  'failed',
  'waiting_human',
  'no_change',
  'needs_info',
]);

export type FactoryRunActionId =
  | 'approve-merge'
  | 'lint-cleanup'
  | 'lint-cleanup-off'
  | 'retry'
  | 'stop';

export interface FactoryRunAction {
  id: FactoryRunActionId;
  label: string;
  run: () => void;
}

/**
 * What the member may do to a run now, in the order they are offered, and the
 * confirmation dialog the merge approval opens. The dialog is returned apart
 * so a menu can close without taking it along: render it outside the menu.
 */
export function useFactoryRunActions(
  projectId: string,
  run: FactoryRun,
): { actions: FactoryRunAction[]; dialog: ReactNode } {
  const { t } = useTranslation();
  const canSteer = useCanSteerProject(projectId);
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  const [confirmingLint, setConfirmingLint] = useState(false);
  const markLintCleanup = (on: boolean) =>
    void setFactoryRunLintCleanup(projectId, run.id, on).orTee((error) =>
      toastError(error, 'factory'),
    );
  const control = (action: 'retry' | 'stop') =>
    void controlFactoryRun(action, projectId, run.id).orTee((error) =>
      toastError(error, 'factory'),
    );
  // The commit the dialog names is the one approved: the server refuses another.
  const approve = () =>
    void approveFactoryMerge(projectId, run.id, run.risk?.headSha ?? '').orTee((error) =>
      // Its conflict has its own message: the run is held on another commit now.
      toastError(error, 'factoryApprove'),
    );
  if (!canSteer) return { actions: [], dialog: null };
  // A high-risk change waits for the member's approval, which a retry would not give.
  const awaitsApproval = isFactoryRunAwaitingMergeApproval(run);
  const reasons = run.risk?.reasons ?? [];
  const actions: FactoryRunAction[] = [];
  if (awaitsApproval) {
    actions.push({
      id: 'approve-merge',
      label: t('factory.approveMerge', 'Approve and merge'),
      run: () => setConfirmingMerge(true),
    });
  }
  // A member's statement that the change only clears lint warnings: offered
  // once the factory classed it high risk, and taken back while the run lives.
  const ended = ENDED_FACTORY_STATES.has(run.state);
  if (!ended && run.riskWaiver) {
    actions.push({
      id: 'lint-cleanup-off',
      label: t('factory.lintCleanupOff', 'Not a lint cleanup'),
      run: () => markLintCleanup(false),
    });
  } else if (!ended && run.risk?.level === 'high') {
    actions.push({
      id: 'lint-cleanup',
      label: t('factory.lintCleanup', 'Lint cleanup'),
      run: () => setConfirmingLint(true),
    });
  }
  if (RETRYABLE.has(run.state) && !awaitsApproval) {
    actions.push({ id: 'retry', label: t('factory.retry', 'Retry'), run: () => control('retry') });
  }
  if (!ENDED_FACTORY_STATES.has(run.state)) {
    actions.push({ id: 'stop', label: t('factory.stop', 'Stop'), run: () => control('stop') });
  }
  const dialog = awaitsApproval ? (
    <ConfirmDialog
      open={confirmingMerge}
      onOpenChange={setConfirmingMerge}
      title={t('factory.approveMergeTitle', 'Merge this high-risk change?')}
      description={t(
        'factory.approveMergeBody',
        'The factory will merge commit {{sha}} of issue #{{issue}} once its checks, review and regression proof still pass. A new commit on the branch needs a new approval.',
        { sha: run.risk?.headSha.slice(0, 7) ?? '', issue: run.issueNumber },
      )}
      warning={
        reasons.length > 0 ? (
          <ul className="space-y-1.5" data-testid="factory-approve-merge-reasons">
            {reasons.map((reason) => (
              <li key={reason}>{reason}</li>
            ))}
          </ul>
        ) : undefined
      }
      confirmLabel={t('factory.approveMerge', 'Approve and merge')}
      cancelLabel={t('common.cancel', 'Cancel')}
      variant="default"
      onCancel={() => setConfirmingMerge(false)}
      onConfirm={() => {
        setConfirmingMerge(false);
        approve();
      }}
    />
  ) : null;
  const lintDialog = (
    <ConfirmDialog
      open={confirmingLint}
      onOpenChange={setConfirmingLint}
      title={t('factory.lintCleanupTitle', 'Treat this run as a lint cleanup?')}
      description={t(
        'factory.lintCleanupBody',
        'Its size and the risks its contract names will no longer hold it: the factory merges it by itself once its checks, review and regression proof pass, whatever commits follow. It still waits for you if it touches a sensitive path, weakens a test, adds a lint suppression or changes the lint configuration.',
      )}
      confirmLabel={t('factory.lintCleanupConfirm', 'Treat as a lint cleanup')}
      cancelLabel={t('common.cancel', 'Cancel')}
      variant="default"
      onCancel={() => setConfirmingLint(false)}
      onConfirm={() => {
        setConfirmingLint(false);
        markLintCleanup(true);
      }}
    />
  );
  return {
    actions,
    dialog: (
      <>
        {dialog}
        {lintDialog}
      </>
    ),
  };
}

const BUTTON_VARIANT: Record<FactoryRunActionId, 'default' | 'outline' | 'ghost'> = {
  'approve-merge': 'default',
  'lint-cleanup': 'outline',
  'lint-cleanup-off': 'ghost',
  retry: 'outline',
  stop: 'ghost',
};

export function FactoryRunControls({
  projectId,
  run,
  testId,
  children,
  showPullRequest = true,
}: {
  projectId: string;
  run: FactoryRun;
  /** False where the pull request is already shown (a kanban card's powerline). */
  showPullRequest?: boolean;
  /** The buttons' test ids, so several copies on one page stay apart. */
  testId: (button: 'pr' | FactoryRunActionId) => string;
  /** More links, between the pull request and the controls. */
  children?: ReactNode;
}) {
  const { actions, dialog } = useFactoryRunActions(projectId, run);
  const prNumber = run.prUrl ? pullRequestNumber(run.prUrl) : null;

  return (
    <>
      {/* The pull request the run opened, as the sidebar shows a thread's: state icon and number. */}
      {showPullRequest && run.prUrl && prNumber !== null && (
        <PRBadge
          prNumber={prNumber}
          prState={run.state === 'merged' ? 'MERGED' : 'OPEN'}
          prUrl={run.prUrl}
          variant="plain"
          showExternalIcon={false}
          data-testid={testId('pr')}
        />
      )}
      {children}
      {actions.map((action) => (
        <Button
          key={action.id}
          size="xs"
          variant={BUTTON_VARIANT[action.id]}
          data-testid={testId(action.id)}
          onClick={action.run}
        >
          {action.label}
        </Button>
      ))}
      {dialog}
    </>
  );
}
