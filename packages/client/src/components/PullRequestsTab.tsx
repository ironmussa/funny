import type { GitHubPR, PRFilterOptions } from '@funny/shared';
import { ExternalLink, GitBranch, GitPullRequest, Loader2, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { PRActionsMenu } from '@/components/pull-requests/PRActionsMenu';
import { PRCompactIdentity } from '@/components/pull-requests/PRCompactIdentity';
import {
  PRFilterBar,
  EMPTY_PR_FILTERS,
  hasActivePRFilters,
  type PRFilterState,
} from '@/components/pull-requests/PRFilterBar';
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
import { usePRDetail, usePRDetailStore } from '@/stores/pr-detail-store';
import { useProjectStore } from '@/stores/project-store';
import {
  useThreadId,
  useThreadBranch,
  useThreadProjectId,
  useThreadWorktreePath,
} from '@/stores/thread-context';
import { useUIStore } from '@/stores/ui-store';

import { PRDetailDialog } from './PRDetailDialog';

const log = createClientLogger('pull-requests-tab');

// ── Helpers ──

type PRState = 'open' | 'closed' | 'all';

// ── Component ──

interface PullRequestsTabProps {
  visible?: boolean;
}

function PullRequestRow({
  pr,
  projectId,
  visible,
  onOpen,
  onCreateThread,
}: {
  pr: GitHubPR;
  projectId: string;
  visible?: boolean;
  onOpen: (pr: GitHubPR) => void;
  onCreateThread: (branch: string) => void;
}) {
  const { detail } = usePRDetail(projectId, pr.number);

  useEffect(() => {
    if (!visible) return;
    void usePRDetailStore.getState().fetchPRDetail(projectId, pr.number);
  }, [projectId, pr.number, visible]);

  const compactPr = detail
    ? {
        ...pr,
        ...detail,
        head: {
          ...pr.head,
          ...detail.head,
        },
        base: {
          ...pr.base,
          ...detail.base,
        },
      }
    : pr;

  return (
    <div
      className="group hover:bg-sidebar-accent/50 flex w-full items-start gap-2 px-3 py-2.5 text-xs transition-colors"
      data-testid={`pr-item-${pr.number}`}
    >
      <PRCompactIdentity
        pr={compactPr}
        onTitleClick={() => onOpen(pr)}
        showStateBadge
        numberTestId={`pr-number-link-${pr.number}`}
        titleTestId={`pr-item-open-${pr.number}`}
        mergeLineTestId={`pr-merge-line-${pr.number}`}
        metaTestId={`pr-meta-${pr.number}`}
        statusTestId={`pr-status-${pr.number}`}
        contentAfterMerge={
          pr.labels.length > 0 ? (
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
          ) : null
        }
      />
      <PRActionsMenu prNumber={pr.number} branch={pr.head.ref} onCreateThread={onCreateThread} />
    </div>
  );
}

function PullRequestsToolbar({
  loading,
  onRefresh,
  filters,
  onFiltersChange,
  filterOptions,
  filterOptionsLoading,
  state,
  onStateChange,
  repoInfo,
}: {
  loading: boolean;
  onRefresh: () => void;
  filters: PRFilterState;
  onFiltersChange: (filters: PRFilterState) => void;
  filterOptions: PRFilterOptions | null;
  filterOptionsLoading: boolean;
  state: PRState;
  onStateChange: (state: PRState) => void;
  repoInfo: { owner: string; repo: string } | null;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="border-sidebar-border flex items-center gap-1.5 overflow-x-auto border-b px-2 py-1.5"
      data-testid="prs-toolbar"
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            disabled={loading}
            className="text-muted-foreground shrink-0"
            data-testid="prs-refresh"
          >
            <RefreshCw className={cn('icon-base', loading && 'animate-spin')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('common.refresh', 'Refresh')}</TooltipContent>
      </Tooltip>

      <PRFilterBar
        value={filters}
        onChange={onFiltersChange}
        options={filterOptions}
        optionsLoading={filterOptionsLoading}
        state={state}
        onStateChange={onStateChange}
        showState
        showBorder={false}
        className="min-w-max flex-nowrap"
      />

      <div className="min-w-0 flex-1" />

      {repoInfo ? (
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
      ) : null}
    </div>
  );
}

function PullRequestsContent({
  loading,
  prCount,
  error,
  searchMode,
  state,
  onRefresh,
  currentBranchPRs,
  otherPRs,
  currentBranch,
  renderPRRow,
  hasMore,
  onLoadMore,
}: {
  loading: boolean;
  prCount: number;
  error: string | null;
  searchMode: boolean;
  state: PRState;
  onRefresh: () => void;
  currentBranchPRs: GitHubPR[];
  otherPRs: GitHubPR[];
  currentBranch?: string;
  renderPRRow: (pr: GitHubPR) => ReactNode;
  hasMore: boolean;
  onLoadMore: () => void;
}) {
  const { t } = useTranslation();

  if (loading && prCount === 0) {
    return (
      <LoadingState
        testId="prs-loading"
        label={t('review.pullRequests.loading', 'Loading pull requests\u2026')}
      />
    );
  }

  if (error) {
    return (
      <EmptyState
        title={error}
        action={
          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            className="gap-1.5"
            data-testid="prs-retry"
          >
            <RefreshCw className="icon-xs" />
            {t('common.retry', 'Retry')}
          </Button>
        }
      />
    );
  }

  if (prCount === 0) {
    return (
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
    );
  }

  return (
    <ScrollArea className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col">
        {currentBranchPRs.length > 0 ? (
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
            <div className="divide-sidebar-border flex flex-col divide-y">
              {currentBranchPRs.map(renderPRRow)}
            </div>
          </>
        ) : null}
        {otherPRs.length > 0 ? (
          <>
            {currentBranchPRs.length > 0 ? (
              <div
                className="border-sidebar-border bg-sidebar-accent/30 text-muted-foreground border-b px-3 py-1 text-[10px] font-medium tracking-wide uppercase"
                data-testid="prs-other-header"
              >
                {t('review.pullRequests.otherPRs', 'Other pull requests')}
              </div>
            ) : null}
            <div className="divide-sidebar-border flex flex-col divide-y">
              {otherPRs.map(renderPRRow)}
            </div>
          </>
        ) : null}
        {hasMore ? (
          <div className="flex justify-center py-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={onLoadMore}
              disabled={loading}
              className="gap-1.5 text-xs"
              data-testid="prs-load-more"
            >
              {loading ? <Loader2 className="icon-xs animate-spin" /> : null}
              {t('review.pullRequests.loadMore', 'Load more')}
            </Button>
          </div>
        ) : null}
      </div>
    </ScrollArea>
  );
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

  const startNewThread = useUIStore((s) => s.startNewThread);

  const [prs, setPrs] = useState<GitHubPR[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [page, setPage] = useState(1);
  const [state, setState] = useState<PRState>('open');
  const [repoInfo, setRepoInfo] = useState<{
    owner: string;
    repo: string;
  } | null>(null);
  const loadedRef = useRef(false);
  const [selectedPR, setSelectedPR] = useState<GitHubPR | null>(null);
  const [currentUserLogin, setCurrentUserLogin] = useState<string | undefined>(undefined);

  // Sort + label/author/assignee/reviewer filters. Any active filter switches
  // the fetch to the server-side Search API (search mode); sort alone stays on
  // the plain list endpoint.
  const [filters, setFilters] = useState<PRFilterState>(EMPTY_PR_FILTERS);
  const [filterOptions, setFilterOptions] = useState<PRFilterOptions | null>(null);
  const [filterOptionsLoading, setFilterOptionsLoading] = useState(false);
  const searchMode = hasActivePRFilters(filters);

  const effectiveState: PRState = state;

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

  const renderPRRow = (pr: GitHubPR) => (
    <PullRequestRow
      key={pr.number}
      pr={pr}
      projectId={projectId!}
      visible={visible}
      onOpen={setSelectedPR}
      onCreateThread={createThreadFromPRBranch}
    />
  );

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
      <PullRequestsToolbar
        loading={loading}
        onRefresh={refresh}
        filters={filters}
        onFiltersChange={setFilters}
        filterOptions={filterOptions}
        filterOptionsLoading={filterOptionsLoading}
        state={state}
        onStateChange={setState}
        repoInfo={repoInfo}
      />

      <PullRequestsContent
        loading={loading}
        prCount={prs.length}
        error={error}
        searchMode={searchMode}
        state={state}
        onRefresh={refresh}
        currentBranchPRs={currentBranchPRs}
        otherPRs={otherPRs}
        currentBranch={currentBranch}
        renderPRRow={renderPRRow}
        hasMore={hasMore}
        onLoadMore={loadMore}
      />

      {/* PR Detail Dialog */}
      {selectedPR && projectId && (
        <PRDetailDialog
          open={!!selectedPR}
          onOpenChange={(open) => {
            if (!open) setSelectedPR(null);
          }}
          projectId={projectId}
          pr={selectedPR}
          currentUserLogin={currentUserLogin}
        />
      )}
    </div>
  );
}
