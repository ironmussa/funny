import type { FileDiffSummary, GitStatusInfo } from '@funny/shared';
import {
  AlertTriangle,
  ExternalLink,
  GitCommit,
  GitMerge,
  GitPullRequest,
  Loader2,
  PenLine,
  Sparkles,
  Upload,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { InlineProgressSteps } from '@/components/InlineProgressSteps';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { CommitAction } from '@/hooks/use-commit-workflow';
import { cn } from '@/lib/utils';
import { type CommitProgressEntry, useCommitProgressStore } from '@/stores/commit-progress-store';
import type { ProjectGitStatus } from '@/stores/git-status-store';
import { editorLabels, useSettingsStore } from '@/stores/settings-store';

interface CommitDraftPanelProps {
  // Workflow progress (top section)
  commitEntry: CommitProgressEntry | undefined;
  commitProgressId: string;
  setActionInProgress: (v: string | null) => void;

  // Visibility gates
  summaries: FileDiffSummary[];
  commitInProgress: boolean;

  // Commit draft (title + body + AI generate)
  commitTitle: string;
  commitBody: string;
  setCommitTitle: (v: string) => void;
  setCommitBody: (v: string) => void;
  generatingMsg: boolean;
  handleGenerateCommitMsg: () => void;

  // Action selector
  selectedAction: CommitAction;
  setSelectedAction: (a: CommitAction) => void;
  actionInProgress: string | null;
  isOnDifferentBranch: boolean;
  gitStatus: GitStatusInfo | ProjectGitStatus | undefined;

  // Submission
  canCommit: boolean;
  handleCommitAction: () => void;

  // Agent gate
  isAgentRunning: boolean | undefined;
  effectiveThreadId: string | undefined;

  // Rebase conflict
  hasRebaseConflict: boolean;
  baseBranch: string | undefined;
  isWorktree: boolean | undefined;
  handleOpenInEditorConflict: () => void;
  handleAskAgentResolve: () => void;
  /** A steer sharee viewing the pane read-only (thread-sharing-steer): commit is
   *  owner-only, so the whole draft panel is hidden. */
  readOnly?: boolean;
}

/**
 * Bottom of the Changes tab: commit-progress steps when a workflow is running,
 * the commit-message input + action selector + submit button when there are
 * uncommitted changes, and a rebase-conflict banner when a merge/rebase failed.
 *
 * Extracted from ReviewPane.tsx as part of the god-file split — see
 * .claude/plans/reviewpane-split.md.
 */
export function CommitDraftPanel({
  commitEntry,
  commitProgressId,
  setActionInProgress,
  summaries,
  commitInProgress,
  commitTitle,
  commitBody,
  setCommitTitle,
  setCommitBody,
  generatingMsg,
  handleGenerateCommitMsg,
  selectedAction,
  setSelectedAction,
  actionInProgress,
  isOnDifferentBranch,
  gitStatus,
  canCommit,
  handleCommitAction,
  isAgentRunning,
  effectiveThreadId,
  hasRebaseConflict,
  baseBranch,
  isWorktree,
  handleOpenInEditorConflict,
  handleAskAgentResolve,
  readOnly,
}: CommitDraftPanelProps) {
  const { t } = useTranslation();

  // A read-only (steer-sharee) viewer never commits — hide the draft entirely.
  if (readOnly) return null;

  return (
    <>
      {/* Workflow progress */}
      {commitEntry && (
        <div className="border-sidebar-border shrink-0 space-y-2 border-t p-2">
          <p className="text-foreground text-xs font-medium">{commitEntry.title}</p>
          <InlineProgressSteps steps={commitEntry.steps} />
          {(() => {
            const hasFailed = commitEntry.steps.some((s) => s.status === 'failed');
            const isRunning = commitEntry.steps.some((s) => s.status === 'running');
            const isFinished =
              !isRunning &&
              (commitEntry.steps.every((s) => s.status === 'completed' || s.status === 'failed') ||
                hasFailed);
            if (isFinished && hasFailed) {
              return (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    useCommitProgressStore.getState().finishCommit(commitProgressId);
                    setActionInProgress(null);
                  }}
                >
                  {t('review.progress.dismiss', 'Dismiss')}
                </Button>
              );
            }
            return null;
          })()}
        </div>
      )}

      {/* Commit input + action selector */}
      {summaries.length > 0 && !commitInProgress && (
        <div className="border-sidebar-border shrink-0 space-y-1.5 border-t p-2">
          <Input
            type="text"
            placeholder={t('review.commitTitle')}
            aria-label={t('review.commitTitle', 'Commit title')}
            data-testid="review-commit-title"
            value={commitTitle}
            onChange={(e) => setCommitTitle(e.target.value)}
            disabled={!!actionInProgress || generatingMsg}
            className="h-auto px-2 py-1.5 text-xs"
          />
          <div className="border-input bg-background focus-within:border-ring focus-within:ring-ring/50 rounded-md border focus-within:ring-1">
            <textarea
              className="placeholder:text-muted-foreground w-full resize-none bg-transparent px-2 py-1.5 text-xs focus-visible:outline-hidden"
              rows={7}
              aria-label={t('review.commitBody', 'Commit body')}
              data-testid="review-commit-body"
              placeholder={t('review.commitBody')}
              value={commitBody}
              onChange={(e) => setCommitBody(e.target.value)}
              disabled={!!actionInProgress || generatingMsg}
            />
            <div className="flex items-center px-1.5 py-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={handleGenerateCommitMsg}
                    disabled={summaries.length === 0 || generatingMsg || !!actionInProgress}
                    data-testid="review-generate-commit-msg"
                  >
                    <Sparkles className={cn('icon-2xs', generatingMsg && 'animate-pulse')} />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {generatingMsg ? t('review.generatingCommitMsg') : t('review.generateCommitMsg')}
                </TooltipContent>
              </Tooltip>
            </div>
          </div>
          <div
            className={cn(
              'grid gap-1 mt-2',
              isOnDifferentBranch
                ? gitStatus?.prNumber
                  ? 'grid-cols-4'
                  : 'grid-cols-5'
                : 'grid-cols-3',
            )}
          >
            {[
              {
                value: 'commit' as const,
                icon: GitCommit,
                label: t('review.commit', 'Commit'),
                testId: 'review-action-commit',
              },
              {
                value: 'amend' as const,
                icon: PenLine,
                label: t('review.amend', 'Amend'),
                testId: 'review-action-amend',
              },
              {
                value: 'commit-push' as const,
                icon: Upload,
                label: t('review.commitAndPush', 'Commit & Push'),
                testId: 'review-action-commit-push',
              },
              ...(!gitStatus?.prNumber && isOnDifferentBranch
                ? [
                    {
                      value: 'commit-pr' as const,
                      icon: GitPullRequest,
                      label: t('review.commitAndCreatePR', 'Commit & Create PR'),
                      testId: 'review-action-commit-pr',
                    },
                  ]
                : []),
              ...(isOnDifferentBranch
                ? [
                    {
                      value: 'commit-merge' as const,
                      icon: GitMerge,
                      label: t('review.commitAndMerge', 'Commit & Merge'),
                      testId: 'review-action-commit-merge',
                    },
                  ]
                : []),
            ].map(({ value, icon: ActionIcon, label, testId }) => (
              <Tooltip key={value}>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    onClick={() => setSelectedAction(value)}
                    disabled={!!actionInProgress || (!!isAgentRunning && !effectiveThreadId)}
                    data-testid={testId}
                    className={cn(
                      'flex flex-col items-center gap-1 rounded-md border p-2 text-center transition-all',
                      'hover:bg-accent/50 disabled:opacity-50 disabled:cursor-not-allowed',
                      selectedAction === value
                        ? 'border-primary bg-primary/5 text-foreground'
                        : 'border-border text-muted-foreground',
                    )}
                  >
                    <ActionIcon
                      className={cn('icon-base', selectedAction === value && 'text-primary')}
                    />
                    <span className="text-xs leading-tight font-medium">{label}</span>
                  </button>
                </TooltipTrigger>
                {isAgentRunning && (
                  <TooltipContent side="top">{t('review.agentRunningTooltip')}</TooltipContent>
                )}
              </Tooltip>
            ))}
          </div>
          <div className="flex gap-1.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex-1">
                  <Button
                    className="w-full"
                    size="sm"
                    onClick={handleCommitAction}
                    disabled={!canCommit}
                    data-testid="review-commit-execute"
                  >
                    {actionInProgress ? <Loader2 className="icon-sm mr-1.5 animate-spin" /> : null}
                    {t('review.continue', 'Continue')}
                  </Button>
                </div>
              </TooltipTrigger>
              {isAgentRunning && (
                <TooltipContent side="top">{t('review.agentRunningTooltip')}</TooltipContent>
              )}
            </Tooltip>
          </div>
        </div>
      )}

      {/* Rebase conflict resolution — shown when merge/rebase failed with conflicts */}
      {hasRebaseConflict && (
        <div className="border-sidebar-border shrink-0 space-y-2 border-t p-3">
          <div className="text-destructive flex items-center gap-2 text-xs">
            <AlertTriangle className="icon-sm" />
            <span>{t('review.mergeConflict', { target: baseBranch || 'main' })}</span>
          </div>
          {isWorktree && (
            <Button
              className="w-full"
              size="sm"
              variant="outline"
              onClick={handleOpenInEditorConflict}
            >
              <ExternalLink className="icon-sm mr-1.5" />
              {t('review.openInEditor', {
                editor: editorLabels[useSettingsStore.getState().defaultEditor],
              })}
            </Button>
          )}
          <Button className="w-full" size="sm" onClick={handleAskAgentResolve}>
            <Sparkles className="icon-sm mr-1.5" />
            {t('review.askAgentResolve')}
          </Button>
        </div>
      )}
    </>
  );
}
