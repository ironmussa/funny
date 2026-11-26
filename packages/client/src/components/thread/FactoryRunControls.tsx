/**
 * A factory run's actions: open its pull request, and the member's controls
 * (retry a failed or parked run, approve merging a high-risk change the
 * factory held, split a run parked as too large into the issues triage
 * proposed, stop one that has not ended). Shared by the
 * project's run list, the footer indicator's popover and the failure card in
 * the thread. Renders the buttons only; the caller lays them out.
 */
import {
  canHoldFactoryRun,
  canMarkFactoryRunDone,
  lintCleanupSource,
  lintCleanupVetoed,
  displayRiskReason,
} from '@funny/shared/contracts/factory';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { PRBadge } from '@/components/PRBadge';
import { Button } from '@/components/ui/button';
import {
  approveFactoryMerge,
  closeFactoryReplacedPr,
  controlFactoryRun,
  holdFactoryRun,
  markFactoryRunDone,
  releaseFactoryRun,
  setFactoryRunLintCleanup,
} from '@/data/factory/actions';
import { useCanSteerProject } from '@/data/projects/hooks';
import type { FactoryRun } from '@/lib/api/factory';
import { ENDED_FACTORY_STATES, isFactoryRunAwaitingMergeApproval } from '@/lib/factory-run-labels';
import type { PRState } from '@/lib/git-icons';
import { toastError } from '@/lib/toast-error';

import { FactoryHoldDialog } from './FactoryHoldDialog';

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

/** Whether a retry is offered: a high-risk change waits for the member's approval, which a retry would not give. */
export function canRetryFactoryRun(run: FactoryRun): boolean {
  return RETRYABLE.has(run.state) && !isFactoryRunAwaitingMergeApproval(run);
}

/** Whether a stop is offered: the run has not ended. */
export function canStopFactoryRun(run: Pick<FactoryRun, 'state'>): boolean {
  return !ENDED_FACTORY_STATES.has(run.state);
}

/** The run that replaced a run: the newest run of the same issue. */
export type FactoryRunReplacement = Pick<FactoryRun, 'issueNumber' | 'prUrl'>;

/**
 * Whether the member may close the pull request of a replaced run: it ended
 * without merging, its pull request is still open and is not the newer run's.
 * The server decides it again before it closes anything.
 */
export function canCloseReplacedPr(
  run: Pick<FactoryRun, 'state' | 'prUrl'>,
  replacedBy: FactoryRunReplacement | null | undefined,
  prState: PRState,
): boolean {
  if (!replacedBy || (run.state !== 'failed' && run.state !== 'stopped')) return false;
  const number = run.prUrl ? pullRequestNumber(run.prUrl) : null;
  if (number === null || prState !== 'OPEN') return false;
  return number !== (replacedBy.prUrl ? pullRequestNumber(replacedBy.prUrl) : null);
}

export type FactoryRunActionId =
  | 'approve-merge'
  | 'close-replaced-pr'
  | 'hold'
  | 'release'
  | 'lint-cleanup'
  | 'lint-cleanup-off'
  | 'mark-done'
  | 'split'
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

/** The parts triage proposed for a run parked because its issue is too large; none otherwise. */
function factoryRunSplitParts(run: Pick<FactoryRun, 'state' | 'triage'>): string[] {
  if (run.state !== 'needs_info' || run.triage?.decision !== 'too_big') return [];
  return run.triage.items ?? [];
}

/**
 * Split a run parked as too large: the factory opens the parts triage proposed
 * as issues, behind a confirmation that lists them. No agent runs for it.
 */
function useSplitAction(projectId: string, run: FactoryRun): OfferedAction {
  const { t } = useTranslation();
  const [confirmingSplit, setConfirmingSplit] = useState(false);
  const parts = factoryRunSplitParts(run);
  if (parts.length === 0) return { action: null, dialog: null };
  const split = () =>
    void controlFactoryRun('split', projectId, run.id).orTee((error) =>
      toastError(error, 'factory'),
    );
  const dialog = (
    <ConfirmDialog
      open={confirmingSplit}
      onOpenChange={setConfirmingSplit}
      title={t('factory.splitTitle', 'Split issue #{{issue}}?', { issue: run.issueNumber })}
      description={t(
        'factory.splitBody',
        'The factory opens one issue per part, with the description of #{{issue}} for context, and queues them. #{{issue}} gets the list and leaves the factory. No agent runs for this.',
        { issue: run.issueNumber },
      )}
      warning={
        <ol className="list-decimal space-y-1.5 pl-4" data-testid="factory-split-parts">
          {parts.map((part) => (
            <li key={part}>{part}</li>
          ))}
        </ol>
      }
      confirmLabel={t('factory.split', 'Split into {{count}} issues', { count: parts.length })}
      cancelLabel={t('common.cancel', 'Cancel')}
      variant="default"
      onCancel={() => setConfirmingSplit(false)}
      onConfirm={() => {
        setConfirmingSplit(false);
        split();
      }}
    />
  );
  return {
    action: {
      id: 'split',
      label: t('factory.split', 'Split into {{count}} issues', { count: parts.length }),
      run: () => setConfirmingSplit(true),
    },
    dialog,
  };
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
 * A run that ended with no change, or was stopped, stayed on the board for a
 * person: the member says nothing more is needed, and the run is done.
 */
function useMarkDoneAction(projectId: string, run: FactoryRun): FactoryRunAction | null {
  const { t } = useTranslation();
  if (!canMarkFactoryRunDone(run.state)) return null;
  return {
    id: 'mark-done',
    label: t('factory.markDone', 'Mark as done'),
    run: () =>
      void markFactoryRunDone(projectId, run.id).orTee((error) => toastError(error, 'factory')),
  };
}

/**
 * Put a run on hold (with the member's reason, asked in a dialog) when it
 * waits for a person or ended without merging, or release one on hold.
 */
function useHoldAction(projectId: string, run: FactoryRun): OfferedAction {
  const { t } = useTranslation();
  const [asking, setAsking] = useState(false);
  if (run.state === 'on_hold') {
    return {
      action: {
        id: 'release',
        label: t('factory.release', 'Release'),
        run: () =>
          void releaseFactoryRun(projectId, run.id).orTee((error) => toastError(error, 'factory')),
      },
      dialog: null,
    };
  }
  if (!canHoldFactoryRun(run.state)) return { action: null, dialog: null };
  return {
    action: { id: 'hold', label: t('factory.hold', 'Put on hold'), run: () => setAsking(true) },
    dialog: (
      <FactoryHoldDialog
        open={asking}
        onOpenChange={setAsking}
        issueNumber={run.issueNumber}
        onConfirm={(reason) => {
          setAsking(false);
          void holdFactoryRun(projectId, run.id, reason).orTee((error) =>
            toastError(error, 'factory'),
          );
        }}
      />
    ),
  };
}

/**
 * Close the pull request a replaced run left open, behind a confirmation that
 * names the newer run's pull request. The branch is deleted with it.
 */
function useCloseReplacedPrAction(
  projectId: string,
  run: FactoryRun,
  replacedBy: FactoryRunReplacement | null | undefined,
  prState: PRState,
): OfferedAction {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const prNumber = run.prUrl ? pullRequestNumber(run.prUrl) : null;
  if (prNumber === null || !canCloseReplacedPr(run, replacedBy, prState)) {
    return { action: null, dialog: null };
  }
  const newerPr = replacedBy?.prUrl ? pullRequestNumber(replacedBy.prUrl) : null;
  const close = () =>
    void closeFactoryReplacedPr(projectId, run.id, prNumber).orTee((error) =>
      toastError(error, 'factory'),
    );
  const dialog = (
    <ConfirmDialog
      open={confirming}
      onOpenChange={setConfirming}
      title={t('factory.closeReplacedPrTitle', 'Close pull request #{{pr}}?', { pr: prNumber })}
      description={
        newerPr === null
          ? t(
              'factory.closeReplacedPrBodyNoPr',
              'A newer run of issue #{{issue}} replaced this run. The factory comments on #{{pr}}, closes it and deletes its branch.',
              { issue: run.issueNumber, pr: prNumber },
            )
          : t(
              'factory.closeReplacedPrBody',
              'A newer run of issue #{{issue}} replaced this run with #{{newer}}. The factory comments on #{{pr}} with a link to #{{newer}}, closes it and deletes its branch.',
              { issue: run.issueNumber, pr: prNumber, newer: newerPr },
            )
      }
      confirmLabel={t('factory.closeReplacedPr', 'Close pull request')}
      cancelLabel={t('common.cancel', 'Cancel')}
      onCancel={() => setConfirming(false)}
      onConfirm={() => {
        setConfirming(false);
        close();
      }}
    />
  );
  return {
    action: {
      id: 'close-replaced-pr',
      label: t('factory.closeReplacedPr', 'Close pull request'),
      run: () => setConfirming(true),
    },
    dialog,
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
  const reasons = (run.risk?.reasons ?? []).map(displayRiskReason);
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
export function useFactoryRunActions(
  projectId: string,
  run: FactoryRun,
  replaced: { by: FactoryRunReplacement | null | undefined; prState: PRState } = {
    by: null,
    prState: 'OPEN',
  },
): FactoryRunActions {
  const { t } = useTranslation();
  const canSteer = useCanSteerProject(projectId);
  const control = (action: 'retry' | 'stop') =>
    void controlFactoryRun(action, projectId, run.id).orTee((error) =>
      toastError(error, 'factory'),
    );
  const approval = useApproveMergeAction(projectId, run);
  const split = useSplitAction(projectId, run);
  const lint = useLintCleanupAction(projectId, run);
  const done = useMarkDoneAction(projectId, run);
  const hold = useHoldAction(projectId, run);
  const closePr = useCloseReplacedPrAction(projectId, run, replaced.by, replaced.prState);
  if (!canSteer) return { actions: [], dialog: null };
  const offered: Array<FactoryRunAction | null> = [
    approval.action,
    split.action,
    lint.action,
    done,
    closePr.action,
  ];
  if (canRetryFactoryRun(run)) {
    offered.push({ id: 'retry', label: t('factory.retry', 'Retry'), run: () => control('retry') });
  }
  if (canStopFactoryRun(run)) {
    offered.push({ id: 'stop', label: t('factory.stop', 'Stop'), run: () => control('stop') });
  }
  // Last: a run that cannot go on until something outside it changes.
  offered.push(hold.action);
  return {
    actions: offered.flatMap((action) => (action ? [action] : [])),
    dialog: (
      <>
        {approval.dialog}
        {split.dialog}
        {lint.dialog}
        {closePr.dialog}
        {hold.dialog}
      </>
    ),
  };
}

const BUTTON_VARIANT: Record<FactoryRunActionId, 'default' | 'outline' | 'ghost'> = {
  'approve-merge': 'default',
  'close-replaced-pr': 'outline',
  'lint-cleanup': 'outline',
  'lint-cleanup-off': 'ghost',
  'mark-done': 'outline',
  hold: 'ghost',
  release: 'outline',
  split: 'outline',
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
