/**
 * A factory run's actions: open its pull request, and the member's controls
 * (retry a failed or parked run, approve merging a high-risk change the
 * factory held, stop one that has not ended). Shared by the
 * project's run list, the footer indicator's popover and the failure card in
 * the thread. Renders the buttons only; the caller lays them out.
 */
import { lintCleanupSource, lintCleanupVetoed } from '@funny/shared/contracts/factory';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PRBadge } from '@/components/PRBadge';
import { Button } from '@/components/ui/button';
import {
  approveFactoryMerge,
  controlFactoryRun,
  markFactoryRunDone,
  setFactoryRunLintCleanup,
} from '@/data/factory/actions';
import { useCanSteerProject } from '@/data/projects/hooks';
import type { FactoryRun } from '@/lib/api/factory';
import {
  ENDED_FACTORY_STATES,
  isFactoryRunAwaitingMergeApproval,
  isFactoryRunNoChange,
} from '@/lib/factory-run-labels';
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
  | 'mark-done'
  | 'retry'
  | 'stop';

export interface FactoryRunAction {
  id: FactoryRunActionId;
  label: string;
  run: () => void;
}

/** One action a run offers, if any, and the confirmation dialog it opens. */
interface OfferedAction {
  action: FactoryRunAction | null;
  dialog: ReactNode;
}

/** The actions a run offers, and the confirmation dialogs they open. */
interface FactoryRunActions {
  actions: FactoryRunAction[];
  dialog: ReactNode;
}

/**
 * The member's veto of triage's lint-cleanup class: "Not a lint cleanup" on a
 * run triage classed as one, and, behind a confirmation, taking that back.
 * A member never classes a run as one: that comes from triage.
 */
function useLintCleanupAction(projectId: string, run: FactoryRun): OfferedAction {
  const { t } = useTranslation();
  const [confirmingLint, setConfirmingLint] = useState(false);
  const markLintCleanup = (on: boolean) =>
    void setFactoryRunLintCleanup(projectId, run.id, on).orTee((error) =>
      toastError(error, 'factory'),
    );
  const dialog = (
    <ConfirmDialog
      open={confirmingLint}
      onOpenChange={setConfirmingLint}
      title={t('factory.lintCleanupTitle', 'Treat this run as a lint cleanup again?')}
      description={t(
        'factory.lintCleanupBody',
        'Triage classed it as a lint cleanup of rules that cannot change behavior. Its size and the risks its contract names will no longer hold it: the factory merges it by itself once its checks, review and regression proof pass, whatever commits follow. It still waits for you if it touches a sensitive path, weakens a test, adds a lint suppression or changes the lint configuration.',
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
  if (ENDED_FACTORY_STATES.has(run.state)) return { action: null, dialog: null };
  if (lintCleanupSource(run) !== null) {
    return {
      action: {
        id: 'lint-cleanup-off',
        label: t('factory.lintCleanupOff', 'Not a lint cleanup'),
        run: () => markLintCleanup(false),
      },
      dialog: null,
    };
  }
  if (!lintCleanupVetoed(run)) return { action: null, dialog: null };
  return {
    action: {
      id: 'lint-cleanup',
      label: t('factory.lintCleanup', 'Lint cleanup'),
      run: () => setConfirmingLint(true),
    },
    dialog,
  };
}

/**
 * The agent found nothing to change and the run stayed on the board for a
 * person: the member agrees, and the run is done.
 */
function useMarkDoneAction(projectId: string, run: FactoryRun): FactoryRunAction | null {
  const { t } = useTranslation();
  if (!isFactoryRunNoChange(run)) return null;
  return {
    id: 'mark-done',
    label: t('factory.markDone', 'Mark as done'),
    run: () =>
      void markFactoryRunDone(projectId, run.id).orTee((error) => toastError(error, 'factory')),
  };
}

/**
 * The member's approval of a high-risk change the factory holds, behind a
 * confirmation that names the commit and why it is held.
 */
function useApproveMergeAction(projectId: string, run: FactoryRun): OfferedAction {
  const { t } = useTranslation();
  const [confirmingMerge, setConfirmingMerge] = useState(false);
  // The commit the dialog names is the one approved: the server refuses another.
  const approve = () =>
    void approveFactoryMerge(projectId, run.id, run.risk?.headSha ?? '').orTee((error) =>
      // Its conflict has its own message: the run is held on another commit now.
      toastError(error, 'factoryApprove'),
    );
  const awaitsApproval = isFactoryRunAwaitingMergeApproval(run);
  const reasons = run.risk?.reasons ?? [];
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
  if (!awaitsApproval) return { action: null, dialog: null };
  return {
    action: {
      id: 'approve-merge',
      label: t('factory.approveMerge', 'Approve and merge'),
      run: () => setConfirmingMerge(true),
    },
    dialog,
  };
}

/**
 * What the member may do to a run now, in the order they are offered, and the
 * confirmation dialogs they open. The dialogs are returned apart so a menu can
 * close without taking them along: render them outside the menu.
 */
export function useFactoryRunActions(projectId: string, run: FactoryRun): FactoryRunActions {
  const { t } = useTranslation();
  const canSteer = useCanSteerProject(projectId);
  const control = (action: 'retry' | 'stop') =>
    void controlFactoryRun(action, projectId, run.id).orTee((error) =>
      toastError(error, 'factory'),
    );
  const approval = useApproveMergeAction(projectId, run);
  const lint = useLintCleanupAction(projectId, run);
  const done = useMarkDoneAction(projectId, run);
  if (!canSteer) return { actions: [], dialog: null };
  const offered: Array<FactoryRunAction | null> = [approval.action, lint.action, done];
  // A high-risk change waits for the member's approval, which a retry would not give.
  if (RETRYABLE.has(run.state) && !approval.action) {
    offered.push({ id: 'retry', label: t('factory.retry', 'Retry'), run: () => control('retry') });
  }
  if (!ENDED_FACTORY_STATES.has(run.state)) {
    offered.push({ id: 'stop', label: t('factory.stop', 'Stop'), run: () => control('stop') });
  }
  return {
    actions: offered.flatMap((action) => (action ? [action] : [])),
    dialog: (
      <>
        {approval.dialog}
        {lint.dialog}
      </>
    ),
  };
}

const BUTTON_VARIANT: Record<FactoryRunActionId, 'default' | 'outline' | 'ghost'> = {
  'approve-merge': 'default',
  'lint-cleanup': 'outline',
  'lint-cleanup-off': 'ghost',
  'mark-done': 'outline',
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
