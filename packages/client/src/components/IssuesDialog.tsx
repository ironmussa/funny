import type { EnrichedGitHubIssue } from '@funny/shared';
import { CircleDot, CircleCheck, MessageSquare, ExternalLink, Plus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { IssueBadges } from '@/components/IssueBadges';
import { LoadMoreSentinel } from '@/components/LoadMoreSentinel';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { usePagedGitHubList, type FetchGitHubListPage } from '@/hooks/use-paged-github-list';
import { api } from '@/lib/api';
import { buildIssueThreadPrompt } from '@/lib/build-issue-thread-prompt';

interface IssueThreadParams {
  prompt: string;
  branchName: string;
  title: string;
}

interface IssuesDialogProps {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateThread?: (params: IssueThreadParams) => void;
}

function timeAgo(dateStr: string, now: number): string {
  const seconds = Math.floor((now - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  return `${Math.floor(days / 30)}mo`;
}

export function IssuesDialog({ projectId, open, onOpenChange, onCreateThread }: IssuesDialogProps) {
  const { t } = useTranslation();
  const now = useMinuteTick();
  const [state, setState] = useState<'open' | 'closed'>('open');

  const fetchPage = useMemo<FetchGitHubListPage<EnrichedGitHubIssue>>(
    () => (page, signal, cursor) =>
      api
        .githubIssuesEnriched(projectId, { state, page, per_page: 30, cursor }, signal)
        .map((data) => ({ ...data, items: data.issues })),
    [projectId, state],
  );
  const {
    items: issues,
    loading,
    error,
    hasMore,
    repoInfo,
    loadMore,
  } = usePagedGitHubList({
    visible: open,
    fetchPage,
    errorFallback: t('issues.error', 'Failed to load issues'),
  });

  const handleCreateThread = useCallback(
    (issue: EnrichedGitHubIssue) => {
      if (!onCreateThread || !repoInfo) return;
      onCreateThread({
        prompt: buildIssueThreadPrompt(issue, repoInfo),
        branchName: issue.suggestedBranchName,
        title: issue.title,
      });
    },
    [onCreateThread, repoInfo],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] max-w-lg flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CircleDot className="icon-base" />
            {t('issues.title')}
          </DialogTitle>
          <DialogDescription className="sr-only">{t('issues.title')}</DialogDescription>
        </DialogHeader>

        {/* State filter */}
        <div className="flex gap-1">
          <Button
            variant={state === 'open' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setState('open')}
            className="h-7 text-xs"
            data-testid="issues-filter-open"
          >
            <CircleDot className="icon-xs mr-1 text-green-500" />
            {t('issues.open')}
          </Button>
          <Button
            variant={state === 'closed' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => setState('closed')}
            className="h-7 text-xs"
            data-testid="issues-filter-closed"
          >
            <CircleCheck className="icon-xs mr-1 text-purple-500" />
            {t('issues.closed')}
          </Button>
        </div>

        {/* Content */}
        <ScrollArea className="-mx-6 min-h-0 flex-1 px-6">
          {loading && issues.length === 0 ? (
            <LoadingState
              fill={false}
              className="py-12"
              testId="issues-loading"
              label={t('common.loading', 'Loading…')}
            />
          ) : error ? (
            <div className="text-muted-foreground py-12 text-center text-sm">
              <p>{t('issues.error')}</p>
              <p className="mt-1 text-xs">{error}</p>
            </div>
          ) : issues.length === 0 ? (
            <EmptyState fill={false} className="py-12" title={t('issues.noIssues')} />
          ) : (
            <div className="space-y-1">
              {issues.map((issue) => (
                <div
                  key={issue.number}
                  className="group hover:bg-accent/50 flex items-start gap-2 rounded-md p-2 transition-colors"
                  data-testid={`issue-item-${issue.number}`}
                >
                  {issue.state === 'open' ? (
                    <CircleDot className="icon-base mt-0.5 shrink-0 text-green-500" />
                  ) : (
                    <CircleCheck className="icon-base mt-0.5 shrink-0 text-purple-500" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-1.5">
                      <a
                        href={issue.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:text-primary line-clamp-2 text-sm font-medium transition-colors"
                      >
                        {issue.title}
                      </a>
                    </div>
                    {issue.body ? (
                      <p
                        className="text-muted-foreground mt-1 line-clamp-3 text-xs whitespace-pre-wrap"
                        data-testid={`issue-body-${issue.number}`}
                      >
                        {issue.body}
                      </p>
                    ) : null}
                    <div className="mt-0.5 flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground text-xs">#{issue.number}</span>
                      <IssueBadges issue={issue} badgeClassName="h-4 text-[10px]" />

                      <span className="text-muted-foreground text-xs">
                        {timeAgo(issue.created_at, now)}
                      </span>
                      {issue.user && (
                        <span className="text-muted-foreground text-xs">{issue.user.login}</span>
                      )}
                      {issue.comments > 0 && (
                        <span className="text-muted-foreground flex items-center gap-0.5 text-xs">
                          <MessageSquare className="icon-xs" />
                          {issue.comments}
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Create thread button — only for issues without a linked branch */}
                  {onCreateThread && !issue.linkedBranch && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="size-6 shrink-0 p-0 opacity-0 transition-opacity group-hover:opacity-100"
                          onClick={() => handleCreateThread(issue)}
                          data-testid={`issue-create-thread-${issue.number}`}
                        >
                          <Plus className="size-3.5" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left">
                        <p>{t('issues.createThread')}</p>
                      </TooltipContent>
                    </Tooltip>
                  )}
                </div>
              ))}

              <LoadMoreSentinel
                hasMore={hasMore}
                loading={loading}
                itemCount={issues.length}
                onLoadMore={loadMore}
                testId="issues-load-more"
              />
            </div>
          )}
        </ScrollArea>

        {/* Footer */}
        {repoInfo && (
          <div className="flex justify-end border-t pt-2">
            <a
              href={`https://github.com/${repoInfo.owner}/${repoInfo.repo}/issues`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs transition-colors"
            >
              {t('issues.viewOnGithub')}
              <ExternalLink className="icon-xs" />
            </a>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
