import type { GitHubPR } from '@funny/shared';
import { ExternalLink, GitBranch, GitPullRequest, List, Loader2, RefreshCw } from 'lucide-react';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { AuthorBadge } from '@/components/AuthorBadge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { cn, resolveThreadBranch } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import {
  useThreadBranch,
  useThreadProjectId,
  useThreadWorktreePath,
} from '@/stores/thread-context';

import { PinnedPRCard } from './PinnedPRCard';
import { PRDetailDialog } from './PRDetailDialog';

const log = createClientLogger('pull-requests-tab');

const DEFAULT_BRANCH_FALLBACKS = new Set(['main', 'master']);

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
  const activeThreadProjectId = useThreadProjectId();
  const activeThreadBranch = useThreadBranch();
  const activeThreadWorktreePath = useThreadWorktreePath();
  const projectId = activeThreadProjectId ?? selectedProjectId;

  // Branch of the current thread (or project when no thread is active) —
  // used to pin the matching PR at the top of the list.
  const threadBranch =
    activeThreadProjectId !== null
      ? resolveThreadBranch({
          branch: activeThreadBranch,
          worktreePath: activeThreadWorktreePath,
        })
      : undefined;
  const projectBranch = useProjectStore((s) =>
    projectId ? s.branchByProject[projectId] : undefined,
  );
  const currentBranch = threadBranch || projectBranch;

  const project = useProjectStore((s) => s.projects.find((p) => p.id === projectId));
  const defaultBranch = project?.defaultBranch || undefined;

  // Are we sitting on the default/main branch? If defaultBranch is unknown,
  // fall back to the common names so we don't lock users out of the full list.
  const isOnDefaultBranch = useMemo(() => {
    if (!currentBranch) return true;
    if (defaultBranch) return currentBranch === defaultBranch;
    return DEFAULT_BRANCH_FALLBACKS.has(currentBranch);
  }, [currentBranch, defaultBranch]);

  const [prs, setPrs] = useState<GitHubPR[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<PRState>('open');
  const [repoInfo, setRepoInfo] = useState<{ owner: string; repo: string } | null>(null);
  const loadedRef = useRef(false);
  const [selectedPR, setSelectedPR] = useState<GitHubPR | null>(null);
  const [currentUserLogin, setCurrentUserLogin] = useState<string | undefined>(undefined);
  // When on a feature branch, we focus on the PR tied to that branch. This
  // toggle lets the user escape to the full listing without switching branches.
  const [viewAll, setViewAll] = useState(false);

  // Branch-focused mode: feature branch + user hasn't opted into the full list.
  const branchFocusMode = !isOnDefaultBranch && !viewAll;
  // In branch-focus mode we force state='all' so a closed/merged PR for the
  // current branch still shows up — the user cares about *this* branch's PR,
  // whatever its state.
  const effectiveState: PRState = branchFocusMode ? 'all' : state;

  useEffect(() => {
    let cancelled = false;
    void api.githubStatus().then((res) => {
      if (cancelled) return;
      if (res.isOk() && res.value.connected) {
        setCurrentUserLogin(res.value.login);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const fetchPRs = useCallback(
    async (pageNum: number, append: boolean) => {
      if (!projectId) return;
      setLoading(true);
      setError(null);

      const result = await api.githubPRs(projectId, {
        state: effectiveState,
        page: pageNum,
        per_page: 30,
      });

      if (result.isOk()) {
        const data = result.value;
        setPrs((prev) => (append ? [...prev, ...data.prs] : data.prs));
        setHasMore(data.hasMore);
        setRepoInfo({ owner: data.owner, repo: data.repo });
      } else {
        log.error('failed to load pull requests', {
          projectId,
          state: effectiveState,
          error: result.error.message,
        });
        setError(
          result.error.message ||
            t('review.pullRequests.fetchError', 'Failed to load pull requests'),
        );
      }
      setLoading(false);
    },
    [projectId, effectiveState, t],
  );

  // Reset and fetch on visibility / project / state change
  useEffect(() => {
    if (!visible || !projectId) return;
    // Avoid double-fetching on mount in StrictMode
    if (!loadedRef.current) {
      loadedRef.current = true;
    }
    setPage(1);
    setPrs([]);
    fetchPRs(1, false);
  }, [visible, projectId, effectiveState, fetchPRs]);

  // When switching to a different branch, reset the "view all" escape hatch
  // so the user lands back in branch-focus mode by default.
  useEffect(() => {
    setViewAll(false);
  }, [currentBranch]);

  const loadMore = () => {
    const next = page + 1;
    setPage(next);
    fetchPRs(next, true);
  };

  const refresh = () => {
    setPage(1);
    fetchPRs(1, false);
  };

  const getPRColor = (pr: GitHubPR) => {
    if (pr.merged_at) return 'text-purple-500';
    if (pr.state === 'closed') return 'text-red-500';
    return 'text-green-500';
  };

  const { currentBranchPRs, otherPRs } = useMemo(() => {
    if (!currentBranch) return { currentBranchPRs: [] as GitHubPR[], otherPRs: prs };
    const match: GitHubPR[] = [];
    const rest: GitHubPR[] = [];
    for (const pr of prs) {
      if (pr.head.ref === currentBranch) match.push(pr);
      else rest.push(pr);
    }
    return { currentBranchPRs: match, otherPRs: rest };
  }, [prs, currentBranch]);

  const renderPRRow = (pr: GitHubPR) => {
    const color = getPRColor(pr);
    return (
      <button
        key={pr.number}
        onClick={() => setSelectedPR(pr)}
        className="flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition-colors hover:bg-sidebar-accent/50"
        data-testid={`pr-item-${pr.number}`}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <div className="flex items-baseline gap-1.5">
            <a
              href={pr.html_url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className={cn('shrink-0 font-mono text-[10px] hover:underline', color)}
              data-testid={`pr-number-link-${pr.number}`}
            >
              #{pr.number}
            </a>
            <span className="font-medium leading-tight">{pr.title}</span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            {pr.user && (
              <AuthorBadge name={pr.user.login} avatarUrl={pr.user.avatar_url} size="xs" />
            )}
            <span>&middot;</span>
            <span>{timeAgo(pr.created_at)}</span>
            {pr.draft && (
              <>
                <span>&middot;</span>
                <Badge variant="outline" className="h-3.5 px-1 py-0 text-[9px] leading-none">
                  {t('review.pullRequests.draft', 'Draft')}
                </Badge>
              </>
            )}
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex min-w-0 items-center gap-1 text-[10px] text-muted-foreground">
                <GitBranch className="size-3 shrink-0" />
                <span
                  className="block max-w-[45%] overflow-hidden text-ellipsis whitespace-nowrap"
                  dir="rtl"
                >
                  <bdi>{pr.head.ref}</bdi>
                </span>
                <span className="shrink-0">&rarr;</span>
                <span
                  className="block max-w-[35%] overflow-hidden text-ellipsis whitespace-nowrap"
                  dir="rtl"
                >
                  <bdi>{pr.base.ref}</bdi>
                </span>
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
      </button>
    );
  };

  if (!projectId) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
        <GitPullRequest className="size-8 opacity-40" />
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
        {/* Refresh */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={refresh}
              disabled={loading}
              className="shrink-0 text-muted-foreground"
              data-testid="prs-refresh"
            >
              <RefreshCw className={cn('icon-base', loading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('common.refresh', 'Refresh')}</TooltipContent>
        </Tooltip>

        {/* State filter — only shown when browsing the full list */}
        {!branchFocusMode && (
          <div className="flex min-w-0 items-center gap-0.5 rounded-md bg-sidebar-accent/50 p-0.5">
            {(['open', 'closed', 'all'] as PRState[]).map((s) => (
              <button
                key={s}
                onClick={() => setState(s)}
                className={cn(
                  'rounded px-2 py-0.5 text-xs font-medium transition-colors',
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
        )}

        {/* Branch-focus indicator + escape hatch */}
        {branchFocusMode && currentBranch && (
          <div
            className="flex min-w-0 items-center gap-1.5 rounded-md bg-sidebar-accent/50 px-2 py-0.5 text-xs text-muted-foreground"
            data-testid="prs-branch-focus-indicator"
          >
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate font-mono text-[11px]">
              <bdi>{currentBranch}</bdi>
            </span>
          </div>
        )}

        <div className="min-w-0 flex-1" />

        {!isOnDefaultBranch && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setViewAll((v) => !v)}
                className={cn('shrink-0', viewAll ? 'text-foreground' : 'text-muted-foreground')}
                data-testid="prs-toggle-view-all"
              >
                <List className="icon-base" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {viewAll
                ? t('review.pullRequests.focusOnBranch', 'Focus on current branch')
                : t('review.pullRequests.viewAll', 'View all pull requests')}
            </TooltipContent>
          </Tooltip>
        )}

        {/* Open on GitHub */}
        {repoInfo && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                asChild
                className="shrink-0 text-muted-foreground"
                data-testid="prs-open-github"
              >
                <a
                  href={`https://github.com/${repoInfo.owner}/${repoInfo.repo}/pulls`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink className="icon-base" />
                </a>
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('review.pullRequests.openOnGithub', 'Open on GitHub')}
            </TooltipContent>
          </Tooltip>
        )}
      </div>

      {/* Content */}
      <ScrollArea className="flex min-h-0 flex-1 flex-col">
        {loading && prs.length === 0 ? (
          <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
            <Loader2 className="icon-sm animate-spin" />
            {t('review.pullRequests.loading', 'Loading pull requests\u2026')}
          </div>
        ) : error ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-xs text-muted-foreground">
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
        ) : branchFocusMode ? (
          currentBranchPRs.length > 0 ? (
            <div className="flex flex-col">
              {currentBranchPRs.map((pr) => (
                <PinnedPRCard
                  key={pr.number}
                  pr={pr}
                  projectId={projectId}
                  currentUserLogin={currentUserLogin}
                />
              ))}
            </div>
          ) : (
            <div
              className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-muted-foreground"
              data-testid="prs-branch-empty"
            >
              <GitPullRequest className="size-8 opacity-40" />
              <p className="text-center text-xs">
                {t('review.pullRequests.noPRForBranch', 'No pull request for this branch yet')}
              </p>
              {currentBranch && (
                <p className="text-center font-mono text-[10px] text-muted-foreground/70">
                  <bdi>{currentBranch}</bdi>
                </p>
              )}
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setViewAll(true)}
                className="mt-1 gap-1.5 text-xs"
                data-testid="prs-view-all-cta"
              >
                <List className="icon-xs" />
                {t('review.pullRequests.viewAll', 'View all pull requests')}
              </Button>
            </div>
          )
        ) : prs.length === 0 ? (
          <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-4 text-muted-foreground">
            <GitPullRequest className="size-8 opacity-40" />
            <p className="text-xs">
              {state === 'open'
                ? t('review.pullRequests.noOpenPRs', 'No open pull requests')
                : state === 'closed'
                  ? t('review.pullRequests.noClosedPRs', 'No closed pull requests')
                  : t('review.pullRequests.noPRs', 'No pull requests')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {currentBranchPRs.length > 0 && (
              <>
                <div
                  className="flex items-center gap-1.5 border-b border-sidebar-border bg-sidebar-accent/30 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                  data-testid="prs-current-branch-header"
                >
                  <GitBranch className="size-3" />
                  <span className="truncate">
                    {t('review.pullRequests.currentBranch', 'Current branch')}
                    {currentBranch ? (
                      <>
                        {' '}
                        &middot; <bdi>{currentBranch}</bdi>
                      </>
                    ) : null}
                  </span>
                </div>
                <div className="flex flex-col">
                  {currentBranchPRs.map((pr) => (
                    <PinnedPRCard
                      key={pr.number}
                      pr={pr}
                      projectId={projectId}
                      currentUserLogin={currentUserLogin}
                    />
                  ))}
                </div>
              </>
            )}
            {otherPRs.length > 0 && (
              <>
                {currentBranchPRs.length > 0 && (
                  <div
                    className="border-b border-sidebar-border bg-sidebar-accent/30 px-3 py-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground"
                    data-testid="prs-other-header"
                  >
                    {t('review.pullRequests.otherPRs', 'Other pull requests')}
                  </div>
                )}
                <div className="flex flex-col divide-y divide-sidebar-border">
                  {otherPRs.map(renderPRRow)}
                </div>
              </>
            )}
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
      </ScrollArea>

      {/* PR Detail Dialog */}
      {selectedPR && projectId && (
        <PRDetailDialog
          open={!!selectedPR}
          onOpenChange={(open) => {
            if (!open) setSelectedPR(null);
          }}
          projectId={projectId}
          pr={selectedPR}
        />
      )}
    </div>
  );
}
