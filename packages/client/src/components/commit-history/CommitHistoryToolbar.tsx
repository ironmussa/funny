import { GitMerge, GitPullRequest, RefreshCw, Upload } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { PullFetchButtons } from '@/components/pull-fetch-buttons';
import { PushButton } from '@/components/push-button';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

interface Props {
  logLoading: boolean;
  unpulledCommitCount: number;
  unpushedCount: number;
  pullInProgress: boolean;
  fetchInProgress: boolean;
  pushInProgress: boolean;
  remoteUrl: string | null | undefined;
  isOnDifferentBranch: boolean;
  isAgentRunning: boolean;
  prNumber?: number;
  prState?: string;
  prUrl?: string;
  threadBranch?: string;
  baseBranch?: string;
  onRefresh: () => void;
  onPull: () => void;
  onFetch: () => void;
  onPush: () => void;
  onPublish: () => void;
  onCreatePR: () => void;
}

/**
 * Top action bar of CommitHistoryTab: refresh + pull/fetch + push (or publish
 * when no origin) + view-PR / create-PR. Extracted so the parent doesn't
 * import PullFetchButtons, PushButton, or the toolbar-only icons.
 */
export function CommitHistoryToolbar({
  logLoading,
  unpulledCommitCount,
  unpushedCount,
  pullInProgress,
  fetchInProgress,
  pushInProgress,
  remoteUrl,
  isOnDifferentBranch,
  isAgentRunning,
  prNumber,
  prState,
  prUrl,
  threadBranch,
  baseBranch,
  onRefresh,
  onPull,
  onFetch,
  onPush,
  onPublish,
  onCreatePR,
}: Props) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-1 border-b border-sidebar-border px-2 py-1">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            className="text-muted-foreground"
            data-testid="history-refresh"
          >
            <RefreshCw className={cn('icon-base', logLoading && 'animate-spin')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">{t('review.refresh', 'Refresh')}</TooltipContent>
      </Tooltip>
      <PullFetchButtons
        onPull={onPull}
        onFetch={onFetch}
        pullInProgress={pullInProgress}
        fetchInProgress={fetchInProgress}
        unpulledCommitCount={unpulledCommitCount}
        testIdPrefix="history"
      />
      {remoteUrl === null ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onPublish}
              className="relative text-muted-foreground"
              data-testid="history-publish-toolbar"
            >
              <Upload className="icon-base" />
              {unpushedCount > 0 && (
                <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-blue-500 px-0.5 text-[9px] font-bold leading-none text-white">
                  {unpushedCount}
                </span>
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">
            {unpushedCount > 0
              ? t('review.publishWithCommits', {
                  count: unpushedCount,
                  defaultValue: `Publish repository (${unpushedCount} commit(s) to push)`,
                })
              : t('review.publishRepo', 'Publish repository')}
          </TooltipContent>
        </Tooltip>
      ) : (
        <PushButton
          onPush={onPush}
          pushInProgress={pushInProgress}
          unpushedCommitCount={unpushedCount}
          testIdPrefix="history"
        />
      )}
      {isOnDifferentBranch && (
        <Tooltip>
          <TooltipTrigger asChild>
            {prNumber ? (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => window.open(prUrl, '_blank')}
                className="ml-auto text-muted-foreground"
                data-testid="history-view-pr"
              >
                {prState === 'MERGED' ? (
                  <GitMerge className="icon-base text-purple-500" />
                ) : (
                  <GitPullRequest className="icon-base text-green-500" />
                )}
              </Button>
            ) : (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onCreatePR}
                disabled={isAgentRunning}
                className="ml-auto text-muted-foreground"
                data-testid="history-create-pr"
              >
                <GitPullRequest className="icon-base" />
              </Button>
            )}
          </TooltipTrigger>
          <TooltipContent side="top">
            {prNumber
              ? t('review.viewPR', { number: prNumber, defaultValue: `View PR #${prNumber}` })
              : t('review.createPRTooltip', {
                  branch: threadBranch || '',
                  target: baseBranch || 'base',
                })}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}
