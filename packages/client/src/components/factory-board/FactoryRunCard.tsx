/**
 * A run on the factory board (openspec factory-pipeline-board): its issue and
 * project, its thread's status pin, the gate chips and why it waits (the
 * column already says which step it is on). Opening it opens
 * the run's detail panel (openspec factory-run-detail). Not draggable: only the
 * server moves a run.
 */
import type { GitStatusInfo } from '@funny/shared';
import { implementingThreadOf } from '@funny/shared/contracts/factory';
import { Check, Clock, MoreVertical, RotateCcw, Square } from 'lucide-react';
import { memo, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { BOARD_CARD_TITLE_CLASS, BoardCard } from '@/components/board/BoardCard';
import { KanbanCard } from '@/components/kanban/KanbanCard';
import { PRBadge } from '@/components/PRBadge';
import {
  type FactoryRunAction,
  type FactoryRunActionId,
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
import { LabelBadge } from '@/components/ui/label-badge';
import { useGitStatusForThread } from '@/data/git-status/hooks';
import type { FactoryQueueRun } from '@/lib/api/factory';
import { factoryRunFallbackTitle } from '@/lib/factory-run-labels';
import { useThreadById } from '@/lib/thread-selectors';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

import { factoryRunActivityAt } from './board-columns';
import { FactoryRunDependencyNote } from './FactoryRunDependencyNote';
import { FactoryRunGateChips } from './FactoryRunGateChips';
import {
  type FactoryRunDependencyLookup,
  isFactoryRunStuck,
  NO_FACTORY_RUN_DEPENDENCIES,
  shortFactoryReason,
} from './run-dependencies';
import { factoryRunStateChip } from './run-state-chip';
import { factoryRunWaitingText } from './run-waiting';
import { timeInCurrentStep } from './step-timings';
import { FactoryRunTimeInStep } from './StepTimeBadges';

/** The thread a card opens: the implementing one, else the run's latest. */
export function factoryRunCardThread(
  run: Pick<FactoryQueueRun, 'threadIds' | 'stepOptions'>,
): string | undefined {
  return implementingThreadOf(run) ?? run.threadIds.at(-1);
}

interface Props {
  run: FactoryQueueRun;
  projectName: string | undefined;
  now: number;
  /** Opens the run's detail panel. */
  onSelect: (run: FactoryQueueRun) => void;
  /** How the listed runs hold each other back. */
  dependencies?: FactoryRunDependencyLookup;
}

/**
 * The thread's git status with the run's pull request filled in, so the card's
 * powerline shows the PR as the kanban does even before the branch lookup has it.
 */
function withRunPullRequest(
  gitStatus: GitStatusInfo | undefined,
  run: Pick<FactoryQueueRun, 'prUrl' | 'state'>,
  threadId: string,
): GitStatusInfo | undefined {
  if (gitStatus?.prNumber || !run.prUrl) return gitStatus;
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
    prState: run.state === 'merged' ? 'MERGED' : 'OPEN',
  };
}

/** What the factory adds under a card's title: gate chips, why it waits, what it blocks. */
function FactoryRunCardBody({
  run,
  onSelect,
  dependencies,
}: {
  run: FactoryQueueRun;
  onSelect: (run: FactoryQueueRun) => void;
  dependencies: FactoryRunDependencyLookup;
}) {
  const { t } = useTranslation();
  const waitingText = factoryRunWaitingText(t, run);
  const waiting = waitingText ? shortFactoryReason(waitingText, 240) : null;
  const state = factoryRunStateChip(t, run);
  return (
    <div className="flex flex-col gap-1.5 empty:hidden">
      {/* The run's state (a column holds several), then what the gates found on the pull request. */}
      <div className="flex flex-wrap items-center gap-1">
        <LabelBadge
          tone={state.tone}
          data-testid={`factory-board-state-${run.id}`}
          data-state={run.state}
        >
          {state.label}
        </LabelBadge>
        <FactoryRunGateChips run={run} />
      </div>
      {waiting && (
        <p
          className={cn(
            'line-clamp-2 text-xs',
            isFactoryRunStuck(run) ? 'text-status-warning' : 'text-muted-foreground',
          )}
          title={waiting}
          data-testid={`factory-board-waiting-${run.id}`}
        >
          {waiting}
        </p>
      )}
      <FactoryRunDependencyNote
        run={run}
        dependencies={dependencies}
        onSelect={onSelect}
        testIdPrefix={`factory-board-deps-${run.id}`}
      />
    </div>
  );
}

const ACTION_ICON: Record<FactoryRunActionId, typeof Check> = {
  'approve-merge': Check,
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

/**
 * A run with a thread is the thread's own kanban card (title, footer with the
 * powerline, diff, PR and time, menu) with the run's chips under the title; a run
 * with no thread yet (still queued) is the same card frame with the issue as
 * its title.
 */
export const FactoryRunCard = memo(function FactoryRunCard({
  run,
  projectName,
  now,
  onSelect,
  dependencies = NO_FACTORY_RUN_DEPENDENCIES,
}: Props) {
  const { t } = useTranslation();
  const threadId = factoryRunCardThread(run);
  const thread = useThreadById(threadId);
  const gitStatus = useGitStatusForThread(thread?.id);
  const open = () => onSelect(run);
  const testId = `factory-board-card-${run.id}`;
  const { actions, dialog } = useFactoryRunActions(run.projectId, run);
  const menuItems = factoryRunMenuItems(run, actions);
  const [menuOpen, setMenuOpen] = useState(false);
  const prNumber = run.prUrl ? pullRequestNumber(run.prUrl) : null;
  // The time in the step takes the footer's time slot, in place of the card's age.
  const stepTime =
    timeInCurrentStep(run) && run.currentStep ? (
      <FactoryRunTimeInStep run={run} now={now} />
    ) : undefined;

  if (thread) {
    return (
      <KanbanCard
        thread={thread}
        projectInfo={projectName ? { name: projectName } : undefined}
        stage={thread.stage ?? 'in_progress'}
        gitStatus={withRunPullRequest(gitStatus, run, thread.id)}
        onOpen={open}
        draggable={false}
        testId={testId}
        menuItems={menuItems}
        time={stepTime}
      >
        <FactoryRunCardBody run={run} onSelect={onSelect} dependencies={dependencies} />
        {dialog}
      </KanbanCard>
    );
  }

  return (
    <BoardCard
      testId={testId}
      draggable={false}
      onOpen={open}
      status={<Clock className="icon-sm text-muted-foreground" />}
      title={
        <span className={BOARD_CARD_TITLE_CLASS} data-testid={`factory-board-open-${run.id}`}>
          {factoryRunFallbackTitle(t, run)}
        </span>
      }
      footer={
        <>
          {projectName && <span className="truncate">{projectName}</span>}
          {/* A run with no thread has no git status to carry its pull request. */}
          {prNumber !== null && (
            <PRBadge
              prNumber={prNumber}
              prState={run.state === 'merged' ? 'MERGED' : 'OPEN'}
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
      actionsOpen={menuOpen}
      actions={
        menuItems ? (
          <FactoryRunMenu run={run} items={menuItems} onOpenChange={setMenuOpen} />
        ) : undefined
      }
    >
      <FactoryRunCardBody run={run} onSelect={onSelect} dependencies={dependencies} />
      {dialog}
    </BoardCard>
  );
});
