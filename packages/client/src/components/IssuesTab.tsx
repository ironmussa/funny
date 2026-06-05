import type { EnrichedGitHubIssue } from '@funny/shared';
import {
  CircleCheck,
  CircleDot,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { buildIssueThreadPrompt } from '@/lib/build-issue-thread-prompt';
import { createClientLogger } from '@/lib/client-logger';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useThreadProjectId } from '@/stores/thread-context';
import { useUIStore } from '@/stores/ui-store';

const log = createClientLogger('issues-tab');

type IssueState = 'open' | 'closed';

function timeAgo(dateStr: string): string {
  const seconds = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.floor(days / 30);
  return `${months}mo`;
}

interface IssuesTabProps {
  visible?: boolean;
}

export function IssuesTab({ visible }: IssuesTabProps) {
  const { t } = useTranslation();
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const activeThreadProjectId = useThreadProjectId();
  const projectId = activeThreadProjectId ?? selectedProjectId;
  const startNewThreadFromIssue = useUIStore((s) => s.startNewThreadFromIssue);

  const [issues, setIssues] = useState<EnrichedGitHubIssue[]>([]);
  const [state, setState] = useState<IssueState>('open');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [repoInfo, setRepoInfo] = useState<{ owner: string; repo: string } | null>(null);
  const loadedRef = useRef(false);

  const fetchIssues = useCallback(
    async (pageNum: number, append: boolean) => {
      if (!projectId) return;
      setLoading(true);
      setError(null);

      const result = await api.githubIssuesEnriched(projectId, {
        state,
        page: pageNum,
        per_page: 30,
      });

      if (result.isOk()) {
        const data = result.value;
        setIssues((prev) => (append ? [...prev, ...data.issues] : data.issues));
        setHasMore(data.hasMore);
        setRepoInfo({ owner: data.owner, repo: data.repo });
      } else {
        log.error('failed to load issues', {
          projectId,
          state,
          error: result.error.message,
        });
        setError(result.error.message || t('issues.error', 'Failed to load issues'));
      }
      setLoading(false);
    },
    [projectId, state, t],
  );

  useEffect(() => {
    if (!visible || !projectId) return;
    loadedRef.current = true;
    setPage(1);
    setIssues([]);
    fetchIssues(1, false);
  }, [visible, projectId, state, fetchIssues]);

  const loadMore = () => {
    const next = page + 1;
    setPage(next);
    fetchIssues(next, true);
  };

  const refresh = () => {
    setPage(1);
    fetchIssues(1, false);
  };

  const handleCreateThread = useCallback(
    (issue: EnrichedGitHubIssue) => {
      if (!projectId || !repoInfo) return;
      startNewThreadFromIssue(projectId, {
        prompt: buildIssueThreadPrompt(issue, repoInfo),
        branchName: issue.suggestedBranchName,
        title: issue.title,
      });
    },
    [projectId, repoInfo, startNewThreadFromIssue],
  );

  if (!projectId) {
    return (
      <EmptyState
        icon={CircleDot}
        title={t('review.issues.noProject', 'Select a project to view issues')}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="issues-tab">
      <div className="flex items-center gap-1 border-b border-sidebar-border px-2 py-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={refresh}
              disabled={loading}
              className="shrink-0 text-muted-foreground"
              data-testid="issues-refresh"
            >
              <RefreshCw className={cn('icon-base', loading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('common.refresh', 'Refresh')}</TooltipContent>
        </Tooltip>

        <ButtonGroup>
          {(['open', 'closed'] as IssueState[]).map((s) => (
            <Button
              key={s}
              variant={state === s ? 'default' : 'outline'}
              size="xs"
              onClick={() => setState(s)}
              data-testid={`issues-filter-${s}`}
            >
              {s === 'open' ? (
                <>
                  <CircleDot className="icon-xs mr-1 text-green-500" />
                  {t('issues.open', 'Open')}
                </>
              ) : (
                <>
                  <CircleCheck className="icon-xs mr-1 text-purple-500" />
                  {t('issues.closed', 'Closed')}
                </>
              )}
            </Button>
          ))}
        </ButtonGroup>

        <div className="min-w-0 flex-1" />

        {repoInfo && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                asChild
                className="shrink-0 text-muted-foreground"
                data-testid="issues-open-github"
              >
                <a
                  href={`https://github.com/${repoInfo.owner}/${repoInfo.repo}/issues`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="icon-base" />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('issues.viewOnGithub', 'View on GitHub')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {loading && issues.length === 0 ? (
        <LoadingState
          fill
          testId="issues-loading"
          label={t('review.issues.loading', 'Loading issues…')}
        />
      ) : error ? (
        <div className="flex flex-1 flex-col items-center justify-center px-4 py-12 text-center text-sm text-muted-foreground">
          <p>{t('issues.error', 'Failed to load issues')}</p>
          <p className="mt-1 text-xs">{error}</p>
        </div>
      ) : issues.length === 0 ? (
        <EmptyState
          icon={CircleDot}
          title={
            state === 'open'
              ? t('review.issues.noOpenIssues', 'No open issues')
              : t('review.issues.noClosedIssues', 'No closed issues')
          }
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="divide-y divide-sidebar-border">
            {issues.map((issue) => (
              <div
                key={issue.number}
                className="group flex items-start gap-2 px-3 py-2 transition-colors hover:bg-sidebar-accent/50"
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
                      className="line-clamp-2 text-xs font-medium leading-tight transition-colors hover:text-primary"
                    >
                      {issue.title}
                    </a>
                  </div>
                  {issue.body ? (
                    <p
                      className="mt-1 line-clamp-3 whitespace-pre-wrap text-[10px] text-muted-foreground"
                      data-testid={`issue-body-${issue.number}`}
                    >
                      {issue.body}
                    </p>
                  ) : null}
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-[10px] text-muted-foreground">#{issue.number}</span>
                    {issue.labels.map((label) => (
                      <Badge
                        key={label.name}
                        variant="outline"
                        className="h-3.5 px-1 text-[9px] leading-none"
                        style={{
                          borderColor: `#${label.color}`,
                          color: `#${label.color}`,
                        }}
                      >
                        {label.name}
                      </Badge>
                    ))}
                    {issue.linkedBranch && (
                      <Badge
                        variant="outline"
                        className="h-3.5 gap-0.5 border-emerald-500/30 px-1 text-[9px] leading-none text-emerald-500"
                      >
                        <GitBranch className="size-2.5" />
                        <span className="max-w-[100px] truncate">{issue.linkedBranch}</span>
                      </Badge>
                    )}
                    {issue.linkedPR && (
                      <a
                        href={issue.linkedPR.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <Badge
                          variant="outline"
                          className="h-3.5 gap-0.5 border-blue-500/30 px-1 text-[9px] leading-none text-blue-500 hover:bg-blue-500/10"
                        >
                          <GitPullRequest className="size-2.5" />#{issue.linkedPR.number}
                        </Badge>
                      </a>
                    )}
                    <span className="text-[10px] text-muted-foreground">
                      {timeAgo(issue.created_at)}
                    </span>
                    {issue.user && (
                      <span className="text-[10px] text-muted-foreground">{issue.user.login}</span>
                    )}
                    {issue.comments > 0 && (
                      <span className="flex items-center gap-0.5 text-[10px] text-muted-foreground">
                        <MessageSquare className="icon-xs" />
                        {issue.comments}
                      </span>
                    )}
                  </div>
                </div>

                {!issue.linkedBranch && (
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
                      <p>{t('issues.createThread', 'Create thread')}</p>
                    </TooltipContent>
                  </Tooltip>
                )}
              </div>
            ))}
          </div>

          {hasMore && (
            <div className="flex justify-center border-t border-sidebar-border py-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={loadMore}
                disabled={loading}
                className="text-xs"
                data-testid="issues-load-more"
              >
                {loading ? <Loader2 className="icon-xs mr-1 animate-spin" /> : null}
                {t('issues.loadMore', 'Load more')}
              </Button>
            </div>
          )}
        </ScrollArea>
      )}
    </div>
  );
}
