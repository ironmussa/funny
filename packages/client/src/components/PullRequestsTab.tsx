import type { GitHubPR, PRFilterOptions } from '@funny/shared';
import { ExternalLink, GitBranch, GitPullRequest, Loader2, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { GitHubProjectGate } from '@/components/GitHubProjectGate';
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
import { useGitHubProjectId } from '@/hooks/use-github-project-id';
import { usePagedGitHubList, type FetchGitHubListPage } from '@/hooks/use-paged-github-list';
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
                aria-label={t('review.pullRequests.openOnGithub', 'Open pull requests on GitHub')}
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
  return (
    <GitHubProjectGate visible={visible}>
      <PullRequestsProjectContent visible={visible} />
    </GitHubProjectGate>
  );
}

/** Branch of the current thread (or project when no thread is active). */
function useCurrentBranch(projectId: string | null): string | undefined {
  const activeThreadProjectId = useThreadProjectId();
  const activeThreadBranch = useThreadBranch();
  const activeThreadWorktreePath = useThreadWorktreePath();
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
  return threadBranch || projectBranch;
}

function useGitHubLogin(): string | undefined {
  const [login, setLogin] = useState<string | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void api.githubStatus().then((res) => {
      if (!cancelled && res.isOk() && res.value.connected) setLogin(res.value.login);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return login;
}

/** Labels + assignable users for the filter dropdowns, loaded once per project. */
function usePRFilterOptions(visible: boolean | undefined, projectId: string | null) {
  const [filterOptions, setFilterOptions] = useState<PRFilterOptions | null>(null);
  const [filterOptionsLoading, setFilterOptionsLoading] = useState(false);

  useEffect(() => {
    setFilterOptions(null);
  }, [projectId]);

  useEffect(() => {
    if (!visible || !projectId) return;
    const controller = new AbortController();
    setFilterOptionsLoading(true);
    void api.githubPRFilterOptions(projectId, controller.signal).then((res) => {
      if (controller.signal.aborted) return;
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
    return () => controller.abort();
  }, [visible, projectId]);

  return { filterOptions, filterOptionsLoading };
}

function prBadgeState(pr: GitHubPR): 'OPEN' | 'MERGED' | 'CLOSED' {
  if (pr.merged_at) return 'MERGED';
  return pr.state === 'closed' ? 'CLOSED' : 'OPEN';
}

/** Mirror the current branch's PR onto the thread's git status (powerline badge). */
function useSyncCurrentBranchPR(threadId: string | null | undefined, pr: GitHubPR | undefined) {
  const prNumber = pr?.number;
  const prUrl = pr?.html_url;
  const prState = pr ? prBadgeState(pr) : undefined;
  useEffect(() => {
    if (!threadId || !prNumber || !prUrl || !prState) return;
    useGitStatusStore.getState().applyPRMetadata(threadId, { prNumber, prUrl, prState });
  }, [threadId, prNumber, prUrl, prState]);
}

function splitByBranch(prs: GitHubPR[], branch: string | undefined) {
  if (!branch) return { currentBranchPRs: [] as GitHubPR[], otherPRs: prs };
  const currentBranchPRs: GitHubPR[] = [];
  const otherPRs: GitHubPR[] = [];
  for (const pr of prs) {
    if (pr.head.ref === branch) currentBranchPRs.push(pr);
    else otherPRs.push(pr);
  }
  return { currentBranchPRs, otherPRs };
}

/** Any active filter switches to the Search API; sort alone stays on the list endpoint. */
function prPageFetcher(
  projectId: string,
  state: PRState,
  filters: PRFilterState,
): FetchGitHubListPage<GitHubPR> {
  const searchMode = hasActivePRFilters(filters);
  return (page, signal) => {
    const params = { state, page, per_page: 30, sort: filters.sort };
    const request = searchMode
      ? api.githubPRsSearch(projectId, { ...params, ...filters }, signal)
      : api.githubPRs(projectId, params, signal);
    return request
      .map((data) => ({ ...data, items: data.prs }))
      .mapErr((error) => {
        if (!signal.aborted) {
          log.error('failed to load pull requests', { projectId, state, error: error.message });
        }
        return error;
      });
  };
}

/**
 * PR list query: state + sort/label/author/assignee/reviewer filters, paginated.
 * Any active filter switches the fetch to the server-side Search API (search
 * mode); sort alone stays on the plain list endpoint.
 */
function usePRList(visible: boolean | undefined, projectId: string | null) {
  const { t } = useTranslation();
  const [state, setState] = useState<PRState>('open');
  const [filters, setFilters] = useState<PRFilterState>(EMPTY_PR_FILTERS);
  const filterOptions = usePRFilterOptions(visible, projectId);

  // Reset filters when switching projects so stale selections don't leak across.
  useEffect(() => {
    setFilters(EMPTY_PR_FILTERS);
  }, [projectId]);

  const fetchPage = useMemo(
    () => (projectId ? prPageFetcher(projectId, state, filters) : null),
    [projectId, state, filters],
  );
  const list = usePagedGitHubList({
    visible,
    fetchPage,
    errorFallback: t('review.pullRequests.fetchError', 'Failed to load pull requests'),
  });

  return {
    ...list,
    ...filterOptions,
    state,
    setState,
    filters,
    setFilters,
    searchMode: hasActivePRFilters(filters),
  };
}

/** PRs whose head is the current branch are pinned on top and mirrored into git status. */
function useCurrentBranchPRs(prs: GitHubPR[], projectId: string | null) {
  const activeThreadId = useThreadId();
  const currentBranch = useCurrentBranch(projectId);
  const split = useMemo(() => splitByBranch(prs, currentBranch), [prs, currentBranch]);
  useSyncCurrentBranchPR(activeThreadId, split.currentBranchPRs[0]);
  return { ...split, currentBranch };
}

function PullRequestsProjectContent({ visible }: PullRequestsTabProps) {
  const { t } = useTranslation();
  const projectId = useGitHubProjectId();
  const currentUserLogin = useGitHubLogin();
  const startNewThread = useUIStore((s) => s.startNewThread);
  const [selectedPR, setSelectedPR] = useState<GitHubPR | null>(null);

  const list = usePRList(visible, projectId);
  const { state, filters, searchMode, loading, refresh } = list;
  const { currentBranchPRs, otherPRs, currentBranch } = useCurrentBranchPRs(list.items, projectId);

  const createThreadFromPRBranch = useCallback(
    (branch: string) => {
      if (!projectId) return;
      startNewThread(projectId, false, branch);
    },
    [projectId, startNewThread],
  );

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
        onFiltersChange={list.setFilters}
        filterOptions={list.filterOptions}
        filterOptionsLoading={list.filterOptionsLoading}
        state={state}
        onStateChange={list.setState}
        repoInfo={list.repoInfo}
      />

      <PullRequestsContent
        loading={loading}
        prCount={list.items.length}
        error={list.error}
        searchMode={searchMode}
        state={state}
        onRefresh={refresh}
        currentBranchPRs={currentBranchPRs}
        otherPRs={otherPRs}
        currentBranch={currentBranch}
        renderPRRow={renderPRRow}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
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
