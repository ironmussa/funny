/**
 * A run on the factory board (openspec factory-pipeline-board): its issue and
 * project, its state dot (a checkbox on hover, to pick runs for a bulk action), the gate chips and why it waits (the
 * column already says which step it is on). Opening it opens
 * the run's detail panel (openspec factory-run-detail). Not draggable: only the
 * server moves a run.
 */
import type { GitStatusInfo } from '@funny/shared';
import { approvalGapFor, implementingThreadOf } from '@funny/shared/contracts/factory';
import {
  Check,
  Folder,
  GitPullRequestClosed,
  MoreVertical,
  Pause,
  Play,
  RotateCcw,
  Sparkles,
  Split,
  Square,
} from 'lucide-react';
import { memo, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BOARD_CARD_TITLE_CLASS, BoardCard } from '@/components/board/BoardCard';
import { KanbanCard } from '@/components/kanban/KanbanCard';
import { PRBadge } from '@/components/PRBadge';
import {
  type FactoryRunAction,
  type FactoryRunActionId,
  type FactoryRunReplacement,
  pullRequestNumber,
  useFactoryRunActions,
} from '@/components/thread/FactoryRunControls';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { usePendingApprovalRequestOfRun } from '@/data/factory/hooks';
import { useGitStatusForThread } from '@/data/git-status/hooks';
import type { FactoryQueueRun } from '@/lib/api/factory';
import {
  factoryRunFallbackTitle,
  factoryRunTitle,
  isFactoryRunAwaitingMergeApproval,
} from '@/lib/factory-run-labels';
import type { PRState } from '@/lib/git-icons';
import { useThreadById } from '@/lib/thread-selectors';
import { timeAgo } from '@/lib/thread-utils';

import { factoryRunActivityAt } from './board-columns';
import { FactoryBoardChip } from './FactoryBoardChip';
import { FactoryRunDependencyNote } from './FactoryRunDependencyNote';
import { FactoryRunGateChips } from './FactoryRunGateChips';
import { FactoryRunStatus, type FactoryRunSelectionProps } from './FactoryRunStatus';
import {
  factoryRunCardThreadLinks,
  FactoryRunLastThreadLink,
  FactoryRunThreadMenuItems,
} from './FactoryRunThreadLinks';
import { type FactoryRunDependencyLookup, NO_FACTORY_RUN_DEPENDENCIES } from './run-dependencies';
import { useFactoryRunPrState } from './run-pr-state';
import { factoryBoardStateChip } from './run-state-chip';
import { timeInCurrentStep } from './step-timings';
import { FactoryRunTimeInStep } from './StepTimeBadges';

/** The card's project, with the folder icon funny shows a project with. */
function FactoryRunProject({ name }: { name: string | undefined }) {
  if (!name) return null;
  return (
    <span className="flex min-w-0 items-center gap-1">
      <Folder className="icon-xs shrink-0" />
      <span className="truncate">{name}</span>
    </span>
  );
}

/** The thread a card opens: the implementing one, else the run's latest. */
export function factoryRunCardThread(
  run: Pick<FactoryQueueRun, 'threadIds' | 'stepOptions'>,
): string | undefined {
  return implementingThreadOf(run) ?? run.threadIds.at(-1);
}

interface Props extends FactoryRunSelectionProps {
  run: FactoryQueueRun;
  projectName: string | undefined;
  now: number;
  /** Opens the run's detail panel. */
  onSelect: (run: FactoryQueueRun) => void;
  /** How the listed runs hold each other back. */
  dependencies?: FactoryRunDependencyLookup;
  /** The newer run of the same issue that replaced this one, if any. */
  replacedBy?: FactoryRunReplacement | null;
}

/**
 * The thread's git status with the run's pull request filled in, so the card's
 * powerline shows the PR as the kanban does even before the branch lookup has it.
 */
function withRunPullRequest(
  gitStatus: GitStatusInfo | undefined,
  run: Pick<FactoryQueueRun, 'prUrl' | 'state'>,
  threadId: string,
  prState: PRState,
): GitStatusInfo | undefined {
  if (!run.prUrl) return gitStatus;
  // The branch lookup may still hold the PR as open after it was merged or
  // closed; a merged or closed state the run knows wins over it.
  if (gitStatus?.prNumber) return prState === 'OPEN' ? gitStatus : { ...gitStatus, prState };
  const prNumber = Number(run.prUrl.match(/\/pull\/(\d+)/)?.[1]);
  if (!prNumber) return gitStatus;
  return {
    ...(gitStatus ?? {
      threadId,
      branchKey: '',
      state: 'clean',
      dirtyFileCount: 0,
      unpushedCommitCount: 0,
      unpulledCommitCount: 0,
      hasRemoteBranch: true,
      isMergedIntoBase: false,
      linesAdded: 0,
      linesDeleted: 0,
    }),
    prNumber,
    prUrl: run.prUrl,
    prState,
  };
}

/**
 * Says that an agent asked the member to approve this held run (openspec
 * factory-agent-tools). Only a run waiting for an approval reads the requests.
 */
function AgentAskedMarker({ run }: { run: FactoryQueueRun }) {
  const { t } = useTranslation();
  const held = isFactoryRunAwaitingMergeApproval(run);
  const request = usePendingApprovalRequestOfRun(run.projectId, run.id, held);
  if (!held || !request || request.sha !== run.risk?.headSha) return null;
  return (
    <FactoryBoardChip
      label={t('factory.approvalRequest.boardChip', 'Approval asked')}
      tone="warning"
      detail={t('factory.approvalRequest.boardMarker', 'An agent asked for your approval')}
      testId={`factory-board-agent-asked-${run.id}`}
    />
  );
}

/**
 * Says that a held run asks again after the member approved another commit,
 * and how much changed since (openspec factory-merge-fewer-bounces, D2).
 */
function AsksAgainMarker({ run }: { run: FactoryQueueRun }) {
  const { t } = useTranslation();
  if (!isFactoryRunAwaitingMergeApproval(run)) return null;
  const gap = approvalGapFor(run.mergeApproval, run.risk?.headSha);
  if (!gap) return null;
  return (
    <FactoryBoardChip
      label={t('factory.approvalGap.boardChip', 'Asks again')}
      tone="warning"
      detail={
        gap.lines === null
          ? t(
              'factory.approvalGap.boardUnknown',
              'Asks again: the change differs from what you approved',
            )
          : t('factory.approvalGap.board', 'Asks again after {{count}} lines changed', {
              count: gap.lines,
            })
      }
      testId={`factory-board-asks-again-${run.id}`}
    />
  );
}

/**
 * Says that a newer run of the issue replaced this one, and its pull request:
 * the card sits in Done although its own pull request may still be open.
 */
function ReplacedMarker({
  run,
  replacedBy,
}: {
  run: FactoryQueueRun;
  replacedBy: FactoryRunReplacement | null | undefined;
}) {
  const { t } = useTranslation();
  if (!replacedBy) return null;
  const newerPr = replacedBy.prUrl ? pullRequestNumber(replacedBy.prUrl) : null;
  return (
    <FactoryBoardChip
      label={
        newerPr === null
          ? t('factoryBoard.replaced', 'Replaced')
          : t('factoryBoard.replacedBy', 'Replaced by #{{pr}}', { pr: newerPr })
      }
      tone="neutral"
      detail={t(
        'factoryBoard.replacedDetail',
        'Issue #{{issue}} was sent to the factory again: a newer run works on it.',
        { issue: run.issueNumber },
      )}
      testId={`factory-board-replaced-${run.id}`}
    />
  );
}

/** What the factory adds under a card's title: the run's state and gate chips. */
function FactoryRunCardBody({
  run,
  hasThread,
  replacedBy,
}: {
  run: FactoryQueueRun;
  hasThread: boolean;
  replacedBy: FactoryRunReplacement | null | undefined;
}) {
  const { t } = useTranslation();
  const state = factoryBoardStateChip(t, run, hasThread);
  return (
    <>
      {/* The run's state when the icon and column do not say it, why it waits, what the gates found. Each explains itself on hover. */}
      <div className="flex flex-wrap items-center gap-1 empty:hidden">
        {state && (
          <FactoryBoardChip
            label={state.label}
            tone={state.tone}
            detail={state.detail}
            testId={`factory-board-state-${run.id}`}
            data={{ 'data-state': run.state }}
          />
        )}
        <ReplacedMarker run={run} replacedBy={replacedBy} />
        <FactoryRunGateChips run={run} />
        <AgentAskedMarker run={run} />
        <AsksAgainMarker run={run} />
      </div>
    </>
  );
}

const ACTION_ICON: Record<FactoryRunActionId, typeof Check> = {
  'approve-merge': Check,
  'close-replaced-pr': GitPullRequestClosed,
  'lint-cleanup': Sparkles,
  'lint-cleanup-off': Sparkles,
  'mark-done': Check,
  hold: Pause,
  release: Play,
  split: Split,
  retry: RotateCcw,
  stop: Square,
};

/** The run's actions as items of a card's three-dot menu. */
function factoryRunMenuItems(run: FactoryQueueRun, actions: FactoryRunAction[]): ReactNode {
  if (actions.length === 0) return null;
  return actions.map((action) => {
    const Icon = ACTION_ICON[action.id];
    return (
      <DropdownMenuItem
        key={action.id}
        data-testid={`factory-board-${action.id}-${run.id}`}
        onClick={(event) => {
          event.stopPropagation();
          action.run();
        }}
      >
        <Icon className="icon-sm" />
        {action.label}
      </DropdownMenuItem>
    );
  });
}

/** The three-dot menu of a card that is not a thread's (a run still queued). */
function FactoryRunMenu({
  run,
  items,
  onOpenChange,
}: {
  run: FactoryQueueRun;
  items: ReactNode;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="muted"
          size="icon-xs"
          tabIndex={-1}
          data-testid={`factory-board-more-${run.id}`}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreVertical className="icon-sm" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="bottom">
        {items}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The card of a run with no thread yet (still queued): the issue as its title. */
function QueuedFactoryRunCard({
  run,
  projectName,
  now,
  testId,
  stepTime,
  menuItems,
  status,
  children,
  below,
  onOpen,
}: {
  run: FactoryQueueRun;
  projectName: string | undefined;
  now: number;
  testId: string;
  stepTime: ReactNode;
  menuItems: ReactNode;
  status: ReactNode;
  children: ReactNode;
  below: ReactNode;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const prNumber = run.prUrl ? pullRequestNumber(run.prUrl) : null;
  const prState = useFactoryRunPrState(run);
  return (
    <BoardCard
      testId={testId}
      draggable={false}
      onOpen={onOpen}
      status={status}
      title={
        <span className={BOARD_CARD_TITLE_CLASS} data-testid={`factory-board-open-${run.id}`}>
          {factoryRunFallbackTitle(t, run)}
        </span>
      }
      footer={
        <>
          <FactoryRunProject name={projectName} />
          <FactoryRunLastThreadLink run={run} />
          {/* A run with no thread has no git status to carry its pull request. */}
          {prNumber !== null && (
            <PRBadge
              prNumber={prNumber}
              prState={prState}
              prUrl={run.prUrl ?? undefined}
              variant="plain"
              size="compact"
              showExternalIcon={false}
              data-testid={`factory-board-pr-${run.id}`}
            />
          )}
        </>
      }
      time={stepTime ?? timeAgo(factoryRunActivityAt(run), t, now)}
      below={below}
      actionsOpen={menuOpen}
      actions={
        menuItems ? (
          <FactoryRunMenu run={run} items={menuItems} onOpenChange={setMenuOpen} />
        ) : undefined
      }
    >
      {children}
    </BoardCard>
  );
}

/** The run's threads, at the bottom of the card's menu under its actions; null with none. */
function runThreadMenuItems(run: Props['run']) {
  return factoryRunCardThreadLinks(run).length > 0 ? <FactoryRunThreadMenuItems run={run} /> : null;
}

/** A card's actions, then the run's threads; null when there is neither. */
function withThreadItems(menuItems: ReactNode, threadItems: ReactNode): ReactNode {
  if (!menuItems && !threadItems) return null;
  return (
    <>
      {menuItems}
      {threadItems}
    </>
  );
}

/** The time in the step, which takes the footer's time slot in place of the card's age. */
function runStepTime(run: Props['run'], now: Props['now']) {
  return timeInCurrentStep(run) && run.currentStep ? (
    <FactoryRunTimeInStep run={run} now={now} />
  ) : undefined;
}

/**
 * A run with a thread is the thread's own kanban card (title, footer with
 * links to the run's threads, PR and time, menu) with the run's chips under the title; a run
 * with no thread yet (still queued) is the same card frame with the issue as
 * its title.
 */
export const FactoryRunCard = memo(function FactoryRunCard({
  run,
  projectName,
  now,
  onSelect,
  dependencies = NO_FACTORY_RUN_DEPENDENCIES,
  replacedBy,
  selected,
  selecting,
  onToggleSelected,
}: Props) {
  const { t } = useTranslation();
  const threadId = factoryRunCardThread(run);
  const thread = useThreadById(threadId);
  const gitStatus = useGitStatusForThread(thread?.id);
  const prState = useFactoryRunPrState(run);
  const open = () => onSelect(run);
  const testId = `factory-board-card-${run.id}`;
  const { actions, dialog } = useFactoryRunActions(run.projectId, run, {
    by: replacedBy,
    prState,
  });
  const menuItems = factoryRunMenuItems(run, actions);
  const threadItems = runThreadMenuItems(run);
  const stepTime = runStepTime(run, now);
  const status = (
    <FactoryRunStatus
      run={run}
      thread={thread}
      selected={selected}
      selecting={selecting}
      onToggleSelected={onToggleSelected}
    />
  );
  const body = <FactoryRunCardBody run={run} hasThread={Boolean(thread)} replacedBy={replacedBy} />;
  // Under the project line, so the card reads title, chips, project, then what it holds up.
  const below = (
    <FactoryRunDependencyNote
      run={run}
      dependencies={dependencies}
      onSelect={onSelect}
      testIdPrefix={`factory-board-deps-${run.id}`}
    />
  );

  // The action dialogs sit beside the card, never inside it: a portal's React
  // events bubble through the component tree, so a click in a dialog would
  // reach the card's onClick and open the run's side panel.
  if (!thread) {
    return (
      <>
        <QueuedFactoryRunCard
          run={run}
          projectName={projectName}
          now={now}
          testId={testId}
          stepTime={stepTime}
          menuItems={withThreadItems(menuItems, threadItems)}
          status={status}
          below={below}
          onOpen={open}
        >
          {body}
        </QueuedFactoryRunCard>
        {dialog}
      </>
    );
  }

  return (
    <>
      <KanbanCard
        thread={thread}
        projectInfo={projectName ? { name: projectName } : undefined}
        stage={thread.stage ?? 'in_progress'}
        gitStatus={withRunPullRequest(gitStatus, run, thread.id, prState)}
        onOpen={open}
        draggable={false}
        testId={testId}
        menuItems={menuItems}
        menuEndItems={threadItems}
        time={stepTime}
        title={factoryRunTitle(t, run, thread.title)}
        status={status}
        // No powerline: each of the run's threads has its own worktree and diff,
        // so the card links the threads (under its chips) instead of one branch.
        footerLead={
          <>
            <FactoryRunProject name={projectName} />
            <FactoryRunLastThreadLink run={run} />
          </>
        }
        below={below}
      >
        {body}
      </KanbanCard>
      {dialog}
    </>
  );
});
