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
import { useTranslation } from 'react-i18next';

import { PullFetchButtons } from '@/components/pull-fetch-buttons';
import { PushButton } from '@/components/push-button';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ProjectGitStatus } from '@/stores/git-status-store';

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
}

/**
 * Toolbar of icon buttons sitting above the file list inside the Changes tab:
 * refresh, pull/fetch, push/publish, merge, create-PR, stage, unstage, stash,
 * discard, ignore.
 *
 * Extracted from ReviewPane.tsx as part of the god-file split — see
 * .claude/plans/reviewpane-split.md.
 */
export function ChangesToolbar({
  refresh,
  loading,
  handlePull,
  handleFetchOrigin,
  pullInProgress,
  fetchInProgress,
  handlePushOnly,
  pushInProgress,
  remoteUrl,
  setPublishDialogOpen,
  unpushedCommitCount,
  threadBranch,
  baseBranch,
  isOnDifferentBranch,
  openMergeDialog,
  mergeInProgress,
  setPrDialog,
  summaries,
  checkedFiles,
  handleStageSelected,
  handleUnstageAll,
  handleStashSelected,
  handleDiscardAll,
  handleIgnoreFiles,
  actionInProgress,
  stashInProgress,
  gitStatus,
  isAgentRunning,
}: ChangesToolbarProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-1 border-b border-sidebar-border px-2 py-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={refresh}
            className="text-muted-foreground"
            data-testid="review-refresh"
          >
            <RefreshCw className={cn('icon-base', loading && 'animate-spin')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{t('review.refresh')}</TooltipContent>
      </Tooltip>
      <PullFetchButtons
        onPull={handlePull}
        onFetch={handleFetchOrigin}
        pullInProgress={pullInProgress}
        fetchInProgress={fetchInProgress}
        unpulledCommitCount={gitStatus?.unpulledCommitCount ?? 0}
        testIdPrefix="review"
      />
      {remoteUrl === null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => setPublishDialogOpen(true)}
              className="relative text-muted-foreground"
              data-testid="review-publish-toolbar"
            >
              <Upload className="icon-base" />
              {unpushedCommitCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-blue-500 px-0.5 text-[9px] font-bold leading-none text-white">
                  {unpushedCommitCount}
                </span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {unpushedCommitCount > 0
              ? t('review.publishWithCommits', {
                  count: unpushedCommitCount,
                  defaultValue: `Publish repository (${unpushedCommitCount} commit(s) to push)`,
                })
              : t('review.publishRepo', 'Publish repository')}
          </TooltipContent>
        </Tooltip>
      ) : (
        <PushButton
          onPush={handlePushOnly}
          pushInProgress={pushInProgress}
          unpushedCommitCount={unpushedCommitCount}
          testIdPrefix="review"
        />
      )}
      {!!threadBranch && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={openMergeDialog}
              disabled={mergeInProgress || summaries.length > 0}
              className="text-muted-foreground"
              data-testid="review-merge-toolbar"
            >
              <GitMerge className={cn('icon-base', mergeInProgress && 'animate-pulse')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {summaries.length > 0
              ? t('review.commitFirst', 'Commit changes before merging')
              : t('review.mergeIntoBranch', {
                  target: baseBranch || 'base',
                  defaultValue: `Merge into branch`,
                })}
          </TooltipContent>
        </Tooltip>
      )}
      {isOnDifferentBranch && (
        <Tooltip>
          <TooltipTrigger asChild>
            {gitStatus?.prNumber ? (
              (() => {
                const prState = gitStatus.prState ?? 'OPEN';
                const PrIcon =
                  prState === 'MERGED'
                    ? GitMerge
                    : prState === 'CLOSED'
                      ? GitPullRequestClosed
                      : GitPullRequest;
                const prIconColor =
                  prState === 'MERGED'
                    ? 'text-purple-500'
                    : prState === 'CLOSED'
                      ? 'text-red-500'
                      : 'text-green-500';
                return (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => window.open(gitStatus.prUrl, '_blank')}
                    className="text-muted-foreground"
                    data-testid="review-view-pr-toolbar"
                  >
                    <PrIcon className={`icon-base ${prIconColor}`} />
                  </Button>
                );
              })()
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setPrDialog({ title: threadBranch || '', body: '' })}
                disabled={!!isAgentRunning}
                className="text-muted-foreground"
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
      )}
      {summaries.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleStageSelected}
              disabled={!!actionInProgress || !!isAgentRunning}
              className="text-muted-foreground"
              data-testid="review-stage-selected"
            >
              <Plus className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {isAgentRunning
              ? t('review.agentRunningTooltip')
              : checkedFiles.size > 0
                ? t('review.stageSelected', { defaultValue: 'Stage selected' })
                : t('review.stageAll', { defaultValue: 'Stage all' })}
          </TooltipContent>
        </Tooltip>
      )}
      {summaries.some((f) => f.staged) && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleUnstageAll}
              disabled={!!actionInProgress || !!isAgentRunning}
              className="text-muted-foreground"
              data-testid="review-unstage-selected"
            >
              <Minus className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {isAgentRunning
              ? t('review.agentRunningTooltip')
              : checkedFiles.size > 0
                ? t('review.unstageSelected', { defaultValue: 'Unstage selected' })
                : t('review.unstageAll', { defaultValue: 'Unstage all' })}
          </TooltipContent>
        </Tooltip>
      )}
      {summaries.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleStashSelected}
              disabled={!!actionInProgress || !!isAgentRunning || stashInProgress}
              className="text-muted-foreground"
              data-testid="review-stash-selected"
            >
              <Archive className={cn('icon-base', stashInProgress && 'animate-pulse')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {isAgentRunning
              ? t('review.agentRunningTooltip')
              : checkedFiles.size > 0
                ? t('review.stashSelected', { defaultValue: 'Stash selected' })
                : t('review.stashAll', { defaultValue: 'Stash all' })}
          </TooltipContent>
        </Tooltip>
      )}
      {summaries.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleDiscardAll}
              disabled={!!actionInProgress || !!isAgentRunning}
              className="text-muted-foreground"
              data-testid="review-discard-all"
            >
              <Undo2 className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {isAgentRunning ? t('review.agentRunningTooltip') : t('review.discard', 'Discard')}
          </TooltipContent>
        </Tooltip>
      )}
      {summaries.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleIgnoreFiles}
              disabled={!!actionInProgress}
              className="text-muted-foreground"
              data-testid="review-ignore-files"
            >
              <EyeOff className="icon-base" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {checkedFiles.size > 0
              ? `Add ${checkedFiles.size} file(s) to .gitignore`
              : 'Add all to .gitignore'}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
