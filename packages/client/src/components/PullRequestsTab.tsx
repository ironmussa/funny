import type { GitHubPR, PRFilterOptions } from '@funny/shared';
import { ExternalLink, GitBranch, GitPullRequest, List, Loader2, RefreshCw } from 'lucide-react';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { AuthorBadge } from '@/components/AuthorBadge';
import { PRActionsMenu } from '@/components/pull-requests/PRActionsMenu';
import {
  PRFilterBar,
  EMPTY_PR_FILTERS,
  hasActivePRFilters,
  type PRFilterState,
} from '@/components/pull-requests/PRFilterBar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { contrastText, pastelize } from '@/components/ui/project-chip';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { cn, resolveThreadBranch } from '@/lib/utils';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import {
  useThreadId,
  useThreadBranch,
  useThreadProjectId,
  useThreadWorktreePath,
} from '@/stores/thread-context';
import { useUIStore } from '@/stores/ui-store';

import { PinnedPRCard } from './PinnedPRCard';
import { PRBadge } from './PRBadge';
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
  const activeThreadId = useThreadId();
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
  const startNewThread = useUIStore((s) => s.startNewThread);

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

  // Sort + label/author/assignee/reviewer filters. Any active filter switches
  // the fetch to the server-side Search API (search mode); sort alone stays on
  // the plain list endpoint.
  const [filters, setFilters] = useState<PRFilterState>(EMPTY_PR_FILTERS);
  const [filterOptions, setFilterOptions] = useState<PRFilterOptions | null>(null);
  const [filterOptionsLoading, setFilterOptionsLoading] = useState(false);
  const searchMode = hasActivePRFilters(filters);

  // Branch-focused mode: feature branch + user hasn't opted into the full list.
  // Search mode forces a flat, repo-wide list (search results carry no branch
  // refs, so there's nothing to pin).
  const branchFocusMode = !isOnDefaultBranch && !viewAll && !searchMode;
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

  // Load filter options (labels + assignable users) once per project.
  useEffect(() => {
    if (!visible || !projectId) return;
    let cancelled = false;
    setFilterOptionsLoading(true);
    void api.githubPRFilterOptions(projectId).then((res) => {
      if (cancelled) return;
      if (res.isOk()) {
        setFilterOptions(res.value);
      } else {
        log.error('failed to load PR filter options', {
          projectId,
          error: res.error.message,
        });
      }
      setFilterOptionsLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [visible, projectId]);

  // Reset filters when switching projects so stale selections don't leak across.
  useEffect(() => {
    setFilters(EMPTY_PR_FILTERS);
    setFilterOptions(null);
  }, [projectId]);

  const fetchPRs = useCallback(
    async (pageNum: number, append: boolean) => {
      if (!projectId) return;
      setLoading(true);
      setError(null);

      const result = searchMode
        ? await api.githubPRsSearch(projectId, {
            state: effectiveState,
            page: pageNum,
            per_page: 30,
            sort: filters.sort,
            labels: filters.labels,
            authors: filters.authors,
            assignees: filters.assignees,
            reviewers: filters.reviewers,
          })
        : await api.githubPRs(projectId, {
            state: effectiveState,
            page: pageNum,
            per_page: 30,
            sort: filters.sort,
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
    [projectId, effectiveState, searchMode, filters, t],
  );

  // Reset and fetch on visibility / project / state / filter / sort change
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

  const createThreadFromPRBranch = useCallback(
    (branch: string) => {
      if (!projectId) return;
      startNewThread(projectId, false, branch);
    },
    [projectId, startNewThread],
  );

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

  const currentBranchPR = currentBranchPRs[0];
  const currentBranchPRNumber = currentBranchPR?.number;
  const currentBranchPRUrl = currentBranchPR?.html_url;
  const currentBranchPRMergedAt = currentBranchPR?.merged_at;
  const currentBranchPRState = currentBranchPR?.state;

  useEffect(() => {
    if (!activeThreadId || !currentBranchPRNumber || !currentBranchPRUrl) return;
    useGitStatusStore.getState().applyPRMetadata(activeThreadId, {
      prNumber: currentBranchPRNumber,
      prUrl: currentBranchPRUrl,
      prState: currentBranchPRMergedAt
        ? 'MERGED'
        : currentBranchPRState === 'closed'
          ? 'CLOSED'
          : 'OPEN',
    });
  }, [
    activeThreadId,
    currentBranchPRMergedAt,
    currentBranchPRNumber,
    currentBranchPRState,
    currentBranchPRUrl,
  ]);

  const renderPRRow = (pr: GitHubPR) => {
    const prState = pr.merged_at ? 'MERGED' : pr.state === 'closed' ? 'CLOSED' : 'OPEN';
    return (
      <div
        key={pr.number}
        className="group hover:bg-sidebar-accent/50 flex w-full items-start gap-2 px-3 py-2.5 text-xs transition-colors"
        data-testid={`pr-item-${pr.number}`}
      >
        <button
          type="button"
          onClick={() => setSelectedPR(pr)}
          className="flex min-w-0 flex-1 flex-col gap-1.5 text-left"
          data-testid={`pr-item-open-${pr.number}`}
        >
          <div className="flex items-baseline gap-1.5">
            <PRBadge
              prNumber={pr.number}
              prState={prState}
              prUrl={pr.html_url}
              size="xxs"
              data-testid={`pr-number-link-${pr.number}`}
            />
            <span className="leading-tight font-medium">{pr.title}</span>
          </div>
          {pr.labels.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {pr.labels.map((label) => {
                const bg = pastelize(`#${label.color}`);
                return (
                  <span
                    key={label.name}
                    className="rounded-full px-1.5 py-0 text-[9px] leading-4 font-medium"
                    style={{ backgroundColor: bg, color: contrastText(bg) }}
                  >
                    {label.name}
                  </span>
                );
              })}
            </div>
          )}
          <div className="text-muted-foreground flex items-center gap-1.5 text-[10px]">
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
        </button>
        <PRActionsMenu
          prNumber={pr.number}
          branch={pr.head.ref}
          onCreateThread={createThreadFromPRBranch}
        />
      </div>
    );
  };

  if (!projectId) {
    return (
      <EmptyState
        icon={GitPullRequest}
        title={t('review.pullRequests.noProject', 'Select a project to view pull requests')}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="pull-requests-tab">
      {/* Toolbar */}
      <div
        className="border-sidebar-border flex items-center gap-1.5 overflow-x-auto border-b px-2 py-1.5"
        data-testid="prs-toolbar"
      >
        {/* Refresh */}
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={refresh}
              disabled={loading}
              className="text-muted-foreground shrink-0"
              data-testid="prs-refresh"
            >
              <RefreshCw className={cn('icon-base', loading && 'animate-spin')} />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">{t('common.refresh', 'Refresh')}</TooltipContent>
        </Tooltip>

        {/* Branch-focus indicator + escape hatch */}
        {branchFocusMode && currentBranch && (
          <div
            className="bg-sidebar-accent/50 text-muted-foreground flex min-w-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-xs"
            data-testid="prs-branch-focus-indicator"
          >
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate font-mono text-[11px]">
              <bdi>{currentBranch}</bdi>
            </span>
          </div>
        )}

        <PRFilterBar
          value={filters}
          onChange={setFilters}
          options={filterOptions}
          optionsLoading={filterOptionsLoading}
          state={state}
          onStateChange={setState}
          showState={!branchFocusMode}
          showBorder={false}
          className="min-w-max flex-nowrap"
        />

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
                className="text-muted-foreground shrink-0"
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
      {loading && prs.length === 0 ? (
        <LoadingState
          testId="prs-loading"
          label={t('review.pullRequests.loading', 'Loading pull requests\u2026')}
        />
      ) : error ? (
        <EmptyState
          title={error}
          action={
            <Button
              variant="outline"
              size="sm"
              onClick={refresh}
              className="gap-1.5"
              data-testid="prs-retry"
            >
              <RefreshCw className="icon-xs" />
              {t('common.retry', 'Retry')}
            </Button>
          }
        />
      ) : branchFocusMode && currentBranchPRs.length === 0 ? (
        <EmptyState
          testId="prs-branch-empty"
          icon={GitPullRequest}
          title={t('review.pullRequests.noPRForBranch', 'No pull request for this branch yet')}
          description={
            currentBranch ? (
              <span className="font-mono">
                <bdi>{currentBranch}</bdi>
              </span>
            ) : undefined
          }
          action={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setViewAll(true)}
              className="gap-1.5 text-xs"
              data-testid="prs-view-all-cta"
            >
              <List className="icon-xs" />
              {t('review.pullRequests.viewAll', 'View all pull requests')}
            </Button>
          }
        />
      ) : !branchFocusMode && prs.length === 0 ? (
        <EmptyState
          icon={GitPullRequest}
          title={
            searchMode
              ? t('review.pullRequests.noMatchingPRs', 'No pull requests match these filters')
              : state === 'open'
                ? t('review.pullRequests.noOpenPRs', 'No open pull requests')
                : state === 'closed'
                  ? t('review.pullRequests.noClosedPRs', 'No closed pull requests')
                  : t('review.pullRequests.noPRs', 'No pull requests')
          }
        />
      ) : (
        <ScrollArea className="flex min-h-0 flex-1 flex-col">
          {branchFocusMode ? (
            <div className="flex flex-col">
              {currentBranchPRs.map((pr) => (
                <PinnedPRCard
                  key={pr.number}
                  pr={pr}
                  projectId={projectId}
                  currentUserLogin={currentUserLogin}
                  onMerged={refresh}
                  onCreateThreadForBranch={createThreadFromPRBranch}
                />
              ))}
            </div>
          ) : (
            <div className="flex flex-col">
              {currentBranchPRs.length > 0 && (
                <>
                  <div
                    className="border-sidebar-border bg-sidebar-accent/30 text-muted-foreground flex items-center gap-1.5 border-b px-3 py-1 text-[10px] font-medium tracking-wide uppercase"
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
                        onMerged={refresh}
                        onCreateThreadForBranch={createThreadFromPRBranch}
                      />
                    ))}
                  </div>
                </>
              )}
              {otherPRs.length > 0 && (
                <>
                  {currentBranchPRs.length > 0 && (
                    <div
                      className="border-sidebar-border bg-sidebar-accent/30 text-muted-foreground border-b px-3 py-1 text-[10px] font-medium tracking-wide uppercase"
                      data-testid="prs-other-header"
                    >
                      {t('review.pullRequests.otherPRs', 'Other pull requests')}
                    </div>
                  )}
                  <div className="divide-sidebar-border flex flex-col divide-y">
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
      )}

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
