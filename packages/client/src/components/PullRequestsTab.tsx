import type { GitHubPR } from '@funny/shared';
import {
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

// ── Helpers ──

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

type PRState = 'open' | 'closed' | 'all';

// ── Component ──

interface PullRequestsTabProps {
  visible?: boolean;
}

export function PullRequestsTab({ visible }: PullRequestsTabProps) {
  const { t } = useTranslation();
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const activeThread = useThreadStore((s) => s.activeThread);
  const projectId = activeThread?.projectId ?? selectedProjectId;

  const [prs, setPrs] = useState<GitHubPR[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<PRState>('open');
  const [repoInfo, setRepoInfo] = useState<{ owner: string; repo: string } | null>(null);
  const loadedRef = useRef(false);

  const fetchPRs = useCallback(
    async (pageNum: number, append: boolean) => {
      if (!projectId) return;
      setLoading(true);
      setError(null);

      const result = await api.githubPRs(projectId, {
        state,
        page: pageNum,
        per_page: 30,
      });

      if (result.isOk()) {
        const data = result.value;
        setPrs((prev) => (append ? [...prev, ...data.prs] : data.prs));
        setHasMore(data.hasMore);
        setRepoInfo({ owner: data.owner, repo: data.repo });
      } else {
        setError(
          result.error.message ||
            t('review.pullRequests.fetchError', 'Failed to load pull requests'),
        );
      }
      setLoading(false);
    },
    [projectId, state, t],
  );

  // Reset and fetch on visibility / project / state change
  useEffect(() => {
    if (!visible || !projectId) return;
    // Avoid double-fetching on mount in StrictMode
    if (!loadedRef.current) {
      loadedRef.current = true;
    }
    setPage(1);
    fetchPRs(1, false);
  }, [visible, projectId, state, fetchPRs]);

  const loadMore = () => {
    const next = page + 1;
    setPage(next);
    fetchPRs(next, true);
  };

  const refresh = () => {
    setPage(1);
    fetchPRs(1, false);
  };

  const getPRIcon = (pr: GitHubPR) => {
    if (pr.merged_at) return GitMerge;
    if (pr.state === 'closed') return GitPullRequestClosed;
    return GitPullRequest;
  };

  const getPRColor = (pr: GitHubPR) => {
    if (pr.merged_at) return 'text-purple-500';
    if (pr.state === 'closed') return 'text-red-500';
    return 'text-green-500';
  };

  if (!projectId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
        <GitPullRequest className="h-8 w-8 opacity-40" />
        <p className="text-xs">
          {t('review.pullRequests.noProject', 'Select a project to view pull requests')}
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="pull-requests-tab">
      {/* Toolbar */}
      <div className="flex items-center gap-1 border-b border-sidebar-border px-2 py-1">
        {/* State filter */}
        <div className="flex items-center gap-0.5 rounded-md bg-sidebar-accent/50 p-0.5">
          {(['open', 'closed', 'all'] as PRState[]).map((s) => (
            <button
              key={s}
              onClick={() => setState(s)}
              className={cn(
                'rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                state === s
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground',
              )}
              data-testid={`prs-filter-${s}`}
            >
              {s === 'open'
                ? t('review.pullRequests.open', 'Open')
                : s === 'closed'
                  ? t('review.pullRequests.closed', 'Closed')
                  : t('review.pullRequests.all', 'All')}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {/* Refresh */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={refresh}
              disabled={loading}
              className="text-muted-foreground"
              data-testid="prs-refresh"
            >
              <RefreshCw className={cn('icon-base', loading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('common.refresh', 'Refresh')}</TooltipContent>
        </Tooltip>

        {/* Open on GitHub */}
        {repoInfo && (
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={`https://github.com/${repoInfo.owner}/${repoInfo.repo}/pulls`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground transition-colors hover:bg-sidebar-accent hover:text-foreground"
                data-testid="prs-open-github"
              >
                <ExternalLink className="icon-base" />
              </a>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('review.pullRequests.openOnGithub', 'Open on GitHub')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Content */}
      <div className="min-h-0 flex-1 overflow-auto">
        {loading && prs.length === 0 ? (
          <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
            <Loader2 className="icon-sm animate-spin" />
            {t('review.pullRequests.loading', 'Loading pull requests\u2026')}
          </div>
        ) : error ? (
          <div className="flex flex-col items-center gap-2 p-4 text-xs text-muted-foreground">
            <p>{error}</p>
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              className="mt-1 gap-1.5"
              data-testid="prs-retry"
            >
              <RefreshCw className="icon-xs" />
              {t('common.retry', 'Retry')}
            </Button>
          </div>
        ) : prs.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
            <GitPullRequest className="h-8 w-8 opacity-40" />
            <p className="text-xs">
              {state === 'open'
                ? t('review.pullRequests.noOpenPRs', 'No open pull requests')
                : state === 'closed'
                  ? t('review.pullRequests.noClosedPRs', 'No closed pull requests')
                  : t('review.pullRequests.noPRs', 'No pull requests')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col divide-y divide-sidebar-border">
            {prs.map((pr) => {
              const Icon = getPRIcon(pr);
              const color = getPRColor(pr);
              return (
                <a
                  key={pr.number}
                  href={pr.html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-2 px-3 py-2 text-xs transition-colors hover:bg-sidebar-accent/50"
                  data-testid={`pr-item-${pr.number}`}
                >
                  <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', color)} />
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <div className="flex items-baseline gap-1.5">
                      <span className="font-medium leading-tight">{pr.title}</span>
                      <span className="shrink-0 text-[10px] text-muted-foreground">
                        #{pr.number}
                      </span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      {pr.user && <span>{pr.user.login}</span>}
                      <span>&middot;</span>
                      <span>{timeAgo(pr.created_at)}</span>
                      {pr.draft && (
                        <>
                          <span>&middot;</span>
                          <Badge
                            variant="outline"
                            className="h-3.5 px-1 py-0 text-[9px] leading-none"
                          >
                            {t('review.pullRequests.draft', 'Draft')}
                          </Badge>
                        </>
                      )}
                    </div>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <div className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
                          <GitBranch className="h-3 w-3 shrink-0" />
                          <span className="truncate">{pr.head.ref}</span>
                          <span className="shrink-0">&rarr;</span>
                          <span className="truncate">{pr.base.ref}</span>
                        </div>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" className="text-xs">
                        {pr.head.ref} &rarr; {pr.base.ref}
                      </TooltipContent>
                    </Tooltip>
                    {pr.labels.length > 0 && (
                      <div className="flex flex-wrap gap-1 pt-0.5">
                        {pr.labels.map((label) => (
                          <span
                            key={label.name}
                            className="rounded-full px-1.5 py-0 text-[9px] leading-4"
                            style={{
                              backgroundColor: `#${label.color}20`,
                              color: `#${label.color}`,
                              border: `1px solid #${label.color}40`,
                            }}
                          >
                            {label.name}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                </a>
              );
            })}
            {hasMore && (
              <div className="flex justify-center py-2">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={loadMore}
                  disabled={loading}
                  className="gap-1.5 text-xs"
                  data-testid="prs-load-more"
                >
                  {loading ? <Loader2 className="icon-xs animate-spin" /> : null}
                  {t('review.pullRequests.loadMore', 'Load more')}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
