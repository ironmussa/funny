import type { EnrichedGitHubIssue } from '@funny/shared';
import {
  CircleCheck,
  CircleDot,
  ExternalLink,
  GitBranch,
  Loader2,
  MessageSquare,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { PRBadge } from '@/components/PRBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
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

  const stateLabel = (s: IssueState): string =>
    s === 'open' ? t('issues.open', 'Open') : t('issues.closed', 'Closed');

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
      <div className="border-sidebar-border flex items-center gap-1 border-b px-2 py-1">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={refresh}
              disabled={loading}
              className="text-muted-foreground shrink-0"
              data-testid="issues-refresh"
            >
              <RefreshCw className={cn('icon-base', loading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('common.refresh', 'Refresh')}</TooltipContent>
        </Tooltip>

        <Select value={state} onValueChange={(v) => setState(v as IssueState)}>
          <SelectTrigger size="xs" className="w-auto gap-1" data-testid="issues-state-trigger">
            <CircleDot className="icon-xs opacity-70" />
            <span>{stateLabel(state)}</span>
          </SelectTrigger>
          <SelectContent>
            {(['open', 'closed'] as IssueState[]).map((s) => (
              <SelectItem key={s} value={s} className="text-xs" data-testid={`issues-filter-${s}`}>
                {stateLabel(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="min-w-0 flex-1" />

        {repoInfo && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                asChild
                className="text-muted-foreground shrink-0"
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
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center px-4 py-12 text-center text-sm">
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
          <div className="divide-sidebar-border divide-y">
            {issues.map((issue) => (
              <div
                key={issue.number}
                className="group hover:bg-sidebar-accent/50 flex items-start gap-2 px-3 py-2 transition-colors"
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
                      className="hover:text-primary line-clamp-2 text-xs leading-tight font-medium transition-colors"
                    >
                      {issue.title}
                    </a>
                  </div>
                  {issue.body ? (
                    <p
                      className="text-muted-foreground mt-1 line-clamp-3 text-[10px] whitespace-pre-wrap"
                      data-testid={`issue-body-${issue.number}`}
                    >
                      {issue.body}
                    </p>
                  ) : null}
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <span className="text-muted-foreground text-[10px]">#{issue.number}</span>
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
                      <PRBadge
                        prNumber={issue.linkedPR.number}
                        prState={
                          issue.linkedPR.state === 'merged'
                            ? 'MERGED'
                            : issue.linkedPR.state === 'closed'
                              ? 'CLOSED'
                              : 'OPEN'
                        }
                        prUrl={issue.linkedPR.url}
                        size="xxs"
                      />
                    )}
                    <span className="text-muted-foreground text-[10px]">
                      {timeAgo(issue.created_at)}
                    </span>
                    {issue.user && (
                      <span className="text-muted-foreground text-[10px]">{issue.user.login}</span>
                    )}
                    {issue.comments > 0 && (
                      <span className="text-muted-foreground flex items-center gap-0.5 text-[10px]">
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
            <div className="border-sidebar-border flex justify-center border-t py-2">
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
