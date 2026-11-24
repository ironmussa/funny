import type { FileDiffSummary, GitStatusInfo } from '@funny/shared';
import {
  Archive,
  EyeOff,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Minus,
  Plus,
  RefreshCw,
  Undo2,
  Upload,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { PullFetchButtons } from '@/components/pull-fetch-buttons';
import { PushButton } from '@/components/push-button';
import { ToolbarCount } from '@/components/review-pane/ToolbarCount';
import { Button } from '@/components/ui/button';
import { CountBadge } from '@/components/ui/count-badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { ProjectGitStatus } from '@/data/git-status/keys';
import { cn } from '@/lib/utils';

interface ChangesToolbarProps {
  // Refresh
  refresh: () => Promise<void> | void;
  loading: boolean;

  // Pull / fetch / push / publish
  handlePull: () => void;
  handleFetchOrigin: () => void;
  pullInProgress: boolean;
  fetchInProgress: boolean;
  handlePushOnly: () => void;
  pushInProgress: boolean;
  remoteUrl: string | null | undefined;
  setPublishDialogOpen: (open: boolean) => void;
  unpushedCommitCount: number;

  // Merge / PR
  threadBranch: string | undefined;
  baseBranch: string | undefined;
  isOnDifferentBranch: boolean;
  openMergeDialog: () => void;
  mergeInProgress: boolean;
  setPrDialog: (d: { title: string; body: string } | null) => void;

  // Selection ops
  summaries: FileDiffSummary[];
  checkedFiles: Set<string>;
  handleStageSelected: () => void;
  handleUnstageAll: () => void;
  handleStashSelected: () => void;
  handleDiscardAll: () => void;
  handleIgnoreFiles: () => void;
  actionInProgress: string | null;
  stashInProgress: boolean;

  // Git status (read-only) — thread mode is GitStatusInfo, project mode is ProjectGitStatus.
  gitStatus: GitStatusInfo | ProjectGitStatus | undefined;

  // Agent
  isAgentRunning: boolean | undefined;

  /** A steer sharee viewing read-only (thread-sharing-steer): every git WRITE is
   *  owner-only, so the toolbar collapses to just Refresh. */
  readOnly?: boolean;
}

/**
 * Toolbar of icon buttons sitting above the file list inside the Changes tab:
 * refresh, pull/fetch, push/publish, merge, create-PR, stage, unstage, stash,
 * discard, ignore.
 *
 * Extracted from ReviewPane.tsx as part of the god-file split — see
 * .claude/plans/reviewpane-split.md.
 */
function RefreshButton({ onRefresh, loading }: { onRefresh: () => void; loading: boolean }) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="muted" size="icon-sm" onClick={onRefresh} data-testid="review-refresh">
          <RefreshCw className={cn('icon-base', loading && 'animate-spin')} />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{t('review.refresh')}</TooltipContent>
    </Tooltip>
  );
}

type PrDialogSetter = ChangesToolbarProps['setPrDialog'];

/** One icon button with a tooltip above it: the shape every toolbar action shares. */
function ToolbarAction({
  onClick,
  disabled,
  testId,
  className,
  tooltip,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  testId: string;
  className?: string;
  tooltip: ReactNode;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="muted"
          size="icon-sm"
          onClick={onClick}
          disabled={disabled}
          className={className}
          data-testid={testId}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top">{tooltip}</TooltipContent>
    </Tooltip>
  );
}

function PublishOrPushButton({
  remoteUrl,
  setPublishDialogOpen,
  unpushedCommitCount,
  handlePushOnly,
  pushInProgress,
}: Pick<
  ChangesToolbarProps,
  'remoteUrl' | 'setPublishDialogOpen' | 'unpushedCommitCount' | 'handlePushOnly' | 'pushInProgress'
>) {
  const { t } = useTranslation();
  if (remoteUrl !== null) {
    return (
      <PushButton
        onPush={handlePushOnly}
        pushInProgress={pushInProgress}
        unpushedCommitCount={unpushedCommitCount}
        testIdPrefix="review"
      />
    );
  }
  return (
    <ToolbarAction
      onClick={() => setPublishDialogOpen(true)}
      className="relative"
      testId="review-publish-toolbar"
      tooltip={
        unpushedCommitCount > 0
          ? t('review.publishWithCommits', {
              count: unpushedCommitCount,
              defaultValue: `Publish repository (${unpushedCommitCount} commit(s) to push)`,
            })
          : t('review.publishRepo', 'Publish repository')
      }
    >
      <Upload className="icon-base" />
      {unpushedCommitCount > 0 && <CountBadge count={unpushedCommitCount} />}
    </ToolbarAction>
  );
}

function PullRequestButton({
  gitStatus,
  threadBranch,
  baseBranch,
  isAgentRunning,
  setPrDialog,
}: {
  gitStatus: ChangesToolbarProps['gitStatus'];
  threadBranch: string | undefined;
  baseBranch: string | undefined;
  isAgentRunning: boolean | undefined;
  setPrDialog: PrDialogSetter;
}) {
  const { t } = useTranslation();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        {gitStatus?.prNumber ? (
          (() => {
            const prState = gitStatus.prState ?? 'OPEN';
            const PrIcon =
              // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- plain literal ternary, not an Effect tagged union
              prState === 'MERGED'
                ? GitMerge
                : prState === 'CLOSED'
                  ? GitPullRequestClosed
                  : GitPullRequest;
            const prIconColor =
              // oxlint-disable-next-line anti-slop-effect/prefer-effect-match -- plain literal ternary, not an Effect tagged union
              prState === 'MERGED'
                ? 'text-status-violet'
                : prState === 'CLOSED'
                  ? 'text-status-error'
                  : 'text-status-success';
            return (
              <Button
                variant="muted"
                size="icon-sm"
                onClick={() => window.open(gitStatus.prUrl, '_blank', 'noopener,noreferrer')}
                data-testid="review-view-pr-toolbar"
              >
                <PrIcon className={`icon-base ${prIconColor}`} />
              </Button>
            );
          })()
        ) : (
          <Button
            variant="muted"
            size="icon-sm"
            onClick={() => setPrDialog({ title: threadBranch || '', body: '' })}
            disabled={!!isAgentRunning}
            data-testid="review-create-pr-toolbar"
          >
            <GitPullRequest className="icon-base" />
          </Button>
        )}
      </TooltipTrigger>
      <TooltipContent side="top">
        {gitStatus?.prNumber
          ? t('review.viewPR', {
              number: gitStatus.prNumber,
              defaultValue: `View PR #${gitStatus.prNumber}`,
            })
          : isAgentRunning
            ? t('review.agentRunningTooltip')
            : t('review.createPRTooltip', {
                branch: threadBranch,
                target: baseBranch || 'base',
              })}
      </TooltipContent>
    </Tooltip>
  );
}

type SelectionActionsProps = Pick<
  ChangesToolbarProps,
  | 'summaries'
  | 'checkedFiles'
  | 'handleStageSelected'
  | 'handleUnstageAll'
  | 'handleStashSelected'
  | 'handleDiscardAll'
  | 'handleIgnoreFiles'
  | 'actionInProgress'
  | 'stashInProgress'
  | 'isAgentRunning'
>;

/**
 * What every selection action shares: whether files are checked, whether a
 * git action or the agent blocks it, and the tooltip shown while the agent runs.
 */
function useSelectionState({
  checkedFiles,
  actionInProgress,
  isAgentRunning,
}: Pick<SelectionActionsProps, 'checkedFiles' | 'actionInProgress' | 'isAgentRunning'>) {
  const { t } = useTranslation();
  return {
    t,
    hasSelection: checkedFiles.size > 0,
    blocked: !!actionInProgress || !!isAgentRunning,
    agentTooltip: isAgentRunning ? t('review.agentRunningTooltip') : null,
  };
}

/** Stage and unstage: the index actions on the changed files. */
function IndexActions(props: SelectionActionsProps) {
  const { summaries, handleStageSelected, handleUnstageAll } = props;
  const { t, hasSelection, blocked, agentTooltip } = useSelectionState(props);
  return (
    <>
      {summaries.length > 0 && (
        <ToolbarAction
          onClick={handleStageSelected}
          disabled={blocked}
          testId="review-stage-selected"
          tooltip={
            agentTooltip ??
            (hasSelection
              ? t('review.stageSelected', { defaultValue: 'Stage selected' })
              : t('review.stageAll', { defaultValue: 'Stage all' }))
          }
        >
          <Plus className="icon-base" />
        </ToolbarAction>
      )}
      {summaries.some((f) => f.staged) && (
        <ToolbarAction
          onClick={handleUnstageAll}
          disabled={blocked}
          testId="review-unstage-selected"
          tooltip={
            agentTooltip ??
            (hasSelection
              ? t('review.unstageSelected', { defaultValue: 'Unstage selected' })
              : t('review.unstageAll', { defaultValue: 'Unstage all' }))
          }
        >
          <Minus className="icon-base" />
        </ToolbarAction>
      )}
    </>
  );
}

/** Stash and discard: the actions that take changes out of the working tree. */
function WorkingTreeActions(props: SelectionActionsProps) {
  const { handleStashSelected, handleDiscardAll, stashInProgress } = props;
  const { t, hasSelection, blocked, agentTooltip } = useSelectionState(props);
  return (
    <>
      <ToolbarAction
        onClick={handleStashSelected}
        disabled={blocked || stashInProgress}
        testId="review-stash-selected"
        tooltip={
          agentTooltip ??
          (hasSelection
            ? t('review.stashSelected', { defaultValue: 'Stash selected' })
            : t('review.stashAll', { defaultValue: 'Stash all' }))
        }
      >
        <Archive className={cn('icon-base', stashInProgress && 'animate-pulse')} />
      </ToolbarAction>
      <ToolbarAction
        onClick={handleDiscardAll}
        disabled={blocked}
        testId="review-discard-all"
        tooltip={agentTooltip ?? t('review.discard', 'Discard')}
      >
        <Undo2 className="icon-base" />
      </ToolbarAction>
    </>
  );
}

function IgnoreFilesAction({
  checkedFiles,
  handleIgnoreFiles,
  actionInProgress,
}: Pick<SelectionActionsProps, 'checkedFiles' | 'handleIgnoreFiles' | 'actionInProgress'>) {
  return (
    <ToolbarAction
      onClick={handleIgnoreFiles}
      disabled={!!actionInProgress}
      testId="review-ignore-files"
      tooltip={
        checkedFiles.size > 0
          ? `Add ${checkedFiles.size} file(s) to .gitignore`
          : 'Add all to .gitignore'
      }
    >
      <EyeOff className="icon-base" />
    </ToolbarAction>
  );
}

/** Stage, unstage, stash, discard and ignore: the actions on the changed files. */
function SelectionActions(props: SelectionActionsProps) {
  const hasChanges = props.summaries.length > 0;
  return (
    <>
      <IndexActions {...props} />
      {hasChanges && <WorkingTreeActions {...props} />}
      {hasChanges && <IgnoreFilesAction {...props} />}
    </>
  );
}

export function ChangesToolbar({
  refresh,
  loading,
  handlePull,
  handleFetchOrigin,
  pullInProgress,
  fetchInProgress,
  threadBranch,
  baseBranch,
  isOnDifferentBranch,
  openMergeDialog,
  mergeInProgress,
  setPrDialog,
  summaries,
  gitStatus,
  isAgentRunning,
  readOnly,
  ...rest
}: ChangesToolbarProps) {
  const { t } = useTranslation();
  const count = (
    <ToolbarCount
      label={t('review.toolbarCount.files', { count: summaries.length })}
      testId="review-count"
    />
  );

  // Read-only viewer (steer sharee): collapse to just Refresh — every other
  // control here is a git write, which is owner-only server-side.
  if (readOnly) {
    return (
      <div className="border-sidebar-border flex items-center gap-1 border-b px-2 py-1">
        <RefreshButton onRefresh={refresh} loading={loading} />
        {count}
      </div>
    );
  }

  return (
    <div className="border-sidebar-border flex items-center gap-1 border-b px-2 py-1">
      <RefreshButton onRefresh={refresh} loading={loading} />
      <PullFetchButtons
        onPull={handlePull}
        onFetch={handleFetchOrigin}
        pullInProgress={pullInProgress}
        fetchInProgress={fetchInProgress}
        unpulledCommitCount={gitStatus?.unpulledCommitCount ?? 0}
        testIdPrefix="review"
      />
      <PublishOrPushButton {...rest} />
      {!!threadBranch && (
        <ToolbarAction
          onClick={openMergeDialog}
          disabled={mergeInProgress || summaries.length > 0}
          testId="review-merge-toolbar"
          tooltip={
            summaries.length > 0
              ? t('review.commitFirst', 'Commit changes before merging')
              : t('review.mergeIntoBranch', {
                  target: baseBranch || 'base',
                  defaultValue: `Merge into branch`,
                })
          }
        >
          <GitMerge className={cn('icon-base', mergeInProgress && 'animate-pulse')} />
        </ToolbarAction>
      )}
      {isOnDifferentBranch && (
        <PullRequestButton
          gitStatus={gitStatus}
          threadBranch={threadBranch}
          baseBranch={baseBranch}
          isAgentRunning={isAgentRunning}
          setPrDialog={setPrDialog}
        />
      )}
      <SelectionActions summaries={summaries} isAgentRunning={isAgentRunning} {...rest} />
      {count}
    </div>
  );
}
