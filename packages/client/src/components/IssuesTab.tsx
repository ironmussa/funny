import type { EnrichedGitHubIssue } from '@funny/shared';
import { MAX_ISSUES_PER_SEND } from '@funny/shared/contracts/factory';
import { MAX_ISSUES_PER_DELETE } from '@funny/shared/contracts/github-issues';
import { CircleCheck, CircleDot, MessageSquare } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { GitHubProjectGate } from '@/components/GitHubProjectGate';
import { IssueLabelBadges, IssueLinkBadges } from '@/components/IssueBadges';
import { IssueChip } from '@/components/IssueChip';
import { IssueDetailDialog } from '@/components/IssueDetailDialog';
import {
  canSelectIssue,
  canSendIssue,
  IssueFactoryStatus,
  IssuesFactoryUnavailable,
  IssueSelectToggle,
  useIssueFactory,
  type IssueFactory,
} from '@/components/issues/IssueFactoryControls';
import {
  EMPTY_ISSUE_FILTERS,
  hasActiveIssueFilters,
  IssueFilterBar,
  type IssueFilterState,
  type IssueState,
} from '@/components/issues/IssueFilterBar';
import { IssuesSelectionBar } from '@/components/issues/IssuesSelectionBar';
import { LoadMoreSentinel } from '@/components/LoadMoreSentinel';
import {
  TabToolbar,
  TabToolbarExternalLink,
  TabToolbarRefresh,
  TabToolbarSpacer,
} from '@/components/review-pane/TabToolbar';
import { ToolbarCount } from '@/components/review-pane/ToolbarCount';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useIssueFilterOptions } from '@/data/issue-filters/hooks';
import { useGitHubProjectId } from '@/hooks/use-github-project-id';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { usePagedGitHubList, type FetchGitHubListPage } from '@/hooks/use-paged-github-list';
import { useResettableState } from '@/hooks/use-resettable-state';
import { api } from '@/lib/api';
import { buildIssueThreadPrompt } from '@/lib/build-issue-thread-prompt';
import { createClientLogger } from '@/lib/client-logger';
import { listRowClassName, listRowTitleClassName } from '@/lib/list-row-styles';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';

const log = createClientLogger('issues-tab');

function timeAgo(dateStr: string, now: number): string {
  const seconds = Math.floor((now - new Date(dateStr).getTime()) / 1000);
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
  return (
    <GitHubProjectGate visible={visible}>
      <IssuesContent visible={visible} />
    </GitHubProjectGate>
  );
}

function IssuesContent({ visible }: IssuesTabProps) {
  const { t } = useTranslation();
  const projectId = useGitHubProjectId();
  const startNewThreadFromIssue = useUIStore((s) => s.startNewThreadFromIssue);
  const [state, setState] = useState<IssueState>('open');
  // Filters belong to the project: switching projects starts without any.
  const [filters, setFilters] = useResettableState<IssueFilterState>(EMPTY_ISSUE_FILTERS, [
    projectId,
  ]);
  const filterOptions = useIssueFilterOptions(projectId, !!visible);
  const [selectedIssue, setSelectedIssue] = useState<EnrichedGitHubIssue | null>(null);

  const fetchPage = useMemo<FetchGitHubListPage<EnrichedGitHubIssue> | null>(() => {
    if (!projectId) return null;
    return (page, signal, cursor) =>
      api
        .githubIssuesEnriched(projectId, { state, page, per_page: 30, cursor, ...filters }, signal)
        .map((data) => ({ ...data, items: data.issues }))
        .mapErr((error) => {
          if (!signal.aborted) {
            log.error('failed to load issues', { projectId, state, error: error.message });
          }
          return error;
        });
  }, [projectId, state, filters]);

  const list = usePagedGitHubList({
    visible,
    fetchPage,
    errorFallback: t('issues.error', 'Failed to load issues'),
  });
  const { repoInfo } = list;

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
      <IssuesToolbar
        loading={list.loading}
        onRefresh={list.refresh}
        repoInfo={repoInfo}
        count={list.items.length}
      />
      <IssueFilterBar
        value={filters}
        onChange={setFilters}
        options={filterOptions.options}
        optionsLoading={filterOptions.loading}
        state={state}
        onStateChange={setState}
      />
      <IssuesBody
        projectId={projectId}
        issues={list.items}
        loading={list.loading}
        error={list.error}
        state={state}
        filtered={hasActiveIssueFilters(filters)}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        onRefresh={list.refresh}
        onOpenIssue={setSelectedIssue}
      />
      {selectedIssue && (
        <IssueDetailDialog
          open
          onOpenChange={(open) => {
            if (!open) setSelectedIssue(null);
          }}
          projectId={projectId}
          issue={selectedIssue}
          onCreateThread={repoInfo ? handleCreateThread : undefined}
        />
      )}
    </div>
  );
}

function IssuesToolbar({
  loading,
  onRefresh,
  repoInfo,
  count,
}: {
  loading: boolean;
  onRefresh: () => void;
  repoInfo: { owner: string; repo: string } | null;
  count: number;
}) {
  const { t } = useTranslation();

  return (
    <TabToolbar data-testid="issues-toolbar">
      <TabToolbarRefresh loading={loading} onRefresh={onRefresh} data-testid="issues-refresh" />

      {repoInfo && (
        <TabToolbarExternalLink
          href={`https://github.com/${repoInfo.owner}/${repoInfo.repo}/issues`}
          label={t('review.issues.openOnGithub', 'Open issues on GitHub')}
          data-testid="issues-open-github"
        />
      )}

      <TabToolbarSpacer />
      <ToolbarCount label={t('review.toolbarCount.issues', { count })} testId="issues-count" />
    </TabToolbar>
  );
}

function IssuesBody({
  projectId,
  issues,
  loading,
  error,
  state,
  filtered,
  hasMore,
  onLoadMore,
  onRefresh,
  onOpenIssue,
}: {
  projectId: string;
  issues: EnrichedGitHubIssue[];
  loading: boolean;
  error: string | null;
  state: IssueState;
  /** A filter is set: the empty state says no issue matches, not that there are none. */
  filtered: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onRefresh: () => void;
  onOpenIssue: (issue: EnrichedGitHubIssue) => void;
}) {
  const { t } = useTranslation();

  if (loading && issues.length === 0) {
    return (
      <LoadingState
        fill
        testId="issues-loading"
        label={t('review.issues.loading', 'Loading issues…')}
      />
    );
  }
  if (error) {
    return (
      <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center px-4 py-12 text-center text-sm">
        <p>{t('issues.error', 'Failed to load issues')}</p>
        <p className="mt-1 text-xs">{error}</p>
      </div>
    );
  }
  if (issues.length === 0) {
    return (
      <EmptyState
        icon={CircleDot}
        title={
          filtered
            ? t('review.issues.noMatchingIssues', 'No issues match these filters')
            : state === 'open'
              ? t('review.issues.noOpenIssues', 'No open issues')
              : t('review.issues.noClosedIssues', 'No closed issues')
        }
      />
    );
  }
  return (
    <IssuesList
      projectId={projectId}
      issues={issues}
      loading={loading}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
      onRefresh={onRefresh}
      onOpenIssue={onOpenIssue}
    />
  );
}

/** The most issues one selection takes: what one send or one delete accepts. */
const MAX_SELECTED = Math.min(MAX_ISSUES_PER_SEND, MAX_ISSUES_PER_DELETE);

/**
 * The issues, plus their state in the caller's factory, and the selection
 * that is sent to it (change factory-manual-queue) or deleted.
 */
function IssuesList({
  projectId,
  issues,
  loading,
  hasMore,
  onLoadMore,
  onRefresh,
  onOpenIssue,
}: {
  projectId: string;
  issues: EnrichedGitHubIssue[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onRefresh: () => void;
  onOpenIssue: (issue: EnrichedGitHubIssue) => void;
}) {
  const now = useMinuteTick();
  const factory = useIssueFactory(projectId);
  const [selected, setSelected] = useState<number[]>([]);
  // One send or delete takes at most MAX_SELECTED issues: past that, a checkbox adds nothing.
  const toggle = useCallback(
    (n: number) =>
      setSelected((current) => {
        if (current.includes(n)) return current.filter((x) => x !== n);
        return current.length < MAX_SELECTED ? [...current, n] : current;
      }),
    [],
  );
  // A selected issue that can no longer be selected (it entered the factory,
  // or left the list) leaves the selection for good, so it does not come back
  // if its run is cancelled.
  const selectable = selected.filter((n) => {
    const issue = issues.find((i) => i.number === n);
    return issue ? canSelectIssue(factory, issue) : false;
  });
  if (selectable.length !== selected.length) setSelected(selectable);
  const sendable = selectable.filter((n) => {
    const issue = issues.find((i) => i.number === n);
    return issue ? canSendIssue(factory, issue) : false;
  });
  const leave = (gone: number[]) =>
    setSelected((current) => current.filter((n) => !gone.includes(n)));

  return (
    <>
      {factory.unavailable && <IssuesFactoryUnavailable projectId={projectId} />}
      <ScrollArea className="min-h-0 flex-1">
        <div className="divide-sidebar-border divide-y">
          {issues.map((issue) => (
            <IssueRow
              key={issue.number}
              projectId={projectId}
              issue={issue}
              now={now}
              factory={factory}
              selected={selectable.includes(issue.number)}
              onToggle={toggle}
              onOpen={onOpenIssue}
            />
          ))}
        </div>

        <LoadMoreSentinel
          hasMore={hasMore}
          loading={loading}
          itemCount={issues.length}
          onLoadMore={onLoadMore}
          testId="issues-load-more"
        />
      </ScrollArea>
      {selectable.length > 0 && (
        <IssuesSelectionBar
          projectId={projectId}
          factory={factory}
          selected={selectable}
          sendable={sendable}
          labelsOf={(n) =>
            issues.find((issue) => issue.number === n)?.labels.map((label) => label.name) ?? []
          }
          onSent={leave}
          onDeleted={(deleted) => {
            leave(deleted);
            if (deleted.length > 0) onRefresh();
          }}
          onClear={() => setSelected([])}
        />
      )}
    </>
  );
}

/** Open (green dot) or closed (purple check). */
function IssueStateIcon({ state, className }: { state: string; className?: string }) {
  return state === 'open' ? (
    <CircleDot className={cn(className, 'text-status-success')} />
  ) : (
    <CircleCheck className={cn(className, 'text-status-violet')} />
  );
}

function IssueRow({
  projectId,
  issue,
  now,
  factory,
  selected,
  onToggle,
  onOpen,
}: {
  projectId: string;
  issue: EnrichedGitHubIssue;
  now: number;
  factory: IssueFactory;
  selected: boolean;
  onToggle: (issueNumber: number) => void;
  onOpen: (issue: EnrichedGitHubIssue) => void;
}) {
  const { t } = useTranslation();
  const factoryRun = factory.active ? factory.latestRun.get(issue.number) : undefined;
  return (
    <div className={listRowClassName} data-testid={`issue-item-${issue.number}`}>
      {canSelectIssue(factory, issue) ? (
        <IssueSelectToggle
          issueNumber={issue.number}
          icon={<IssueStateIcon state={issue.state} className="icon-base" />}
          checked={selected}
          onToggle={onToggle}
        />
      ) : (
        <IssueStateIcon state={issue.state} className="icon-base mt-0.5 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* As on GitHub: the title, its labels right after it on the same line… */}
        <p className="min-w-0 leading-5">
          <button
            type="button"
            onClick={() => onOpen(issue)}
            className={cn(
              listRowTitleClassName,
              'hover:text-primary inline cursor-pointer text-left break-words transition-colors',
            )}
            data-testid={`issue-title-${issue.number}`}
          >
            {issue.title}
          </button>
          {issue.labels.length > 0 && (
            <span data-testid={`issue-tags-${issue.number}`}>
              <IssueLabelBadges issue={issue} plain className="ml-1 align-middle" />
            </span>
          )}
        </p>
        {/* …then the number (the thread list's chip), who opened it and when. */}
        <div
          className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs"
          data-testid={`issue-meta-${issue.number}`}
        >
          <IssueChip
            projectId={projectId}
            number={issue.number}
            closed={issue.state !== 'open'}
            githubUrl={issue.html_url}
            showStateIcon={false}
            data-testid={`issue-number-${issue.number}`}
          />
          <span>
            {issue.user
              ? t('issues.openedBy', '{{author}} opened {{time}} ago', {
                  author: issue.user.login,
                  time: timeAgo(issue.created_at, now),
                })
              : t('issues.opened', 'opened {{time}} ago', {
                  time: timeAgo(issue.created_at, now),
                })}
          </span>
        </div>
        {/* funny's own: the linked branch and pull request… */}
        <div
          className="mt-1 flex flex-wrap items-center gap-1.5 empty:hidden"
          data-testid={`issue-links-${issue.number}`}
        >
          <IssueLinkBadges issue={issue} projectId={projectId} />
        </div>
        {/* …and the issue's state in the factory. */}
        {factoryRun && (
          <div
            className="mt-1 flex items-center gap-1.5"
            data-testid={`issue-factory-line-${issue.number}`}
          >
            <IssueFactoryStatus
              projectId={projectId}
              run={factoryRun}
              position={factory.queuePosition.get(issue.number)}
            />
          </div>
        )}
      </div>

      {issue.comments > 0 && (
        <button
          type="button"
          onClick={() => onOpen(issue)}
          className="text-muted-foreground hover:text-primary flex shrink-0 cursor-pointer items-center gap-1 pt-0.5 text-xs transition-colors"
          aria-label={t('issues.commentCount', '{{count}} comments', { count: issue.comments })}
          data-testid={`issue-comments-${issue.number}`}
        >
          <MessageSquare className="icon-sm" />
          {issue.comments}
        </button>
      )}
    </div>
  );
}
