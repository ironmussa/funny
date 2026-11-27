import type { EnrichedGitHubIssue } from '@funny/shared';
import { MAX_ISSUES_PER_SEND } from '@funny/shared/contracts/factory';
import { MAX_ISSUES_PER_DELETE } from '@funny/shared/contracts/github-issues';
import type { TFunction } from 'i18next';
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
import { TriCheckbox } from '@/components/ui/tri-checkbox';
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
  if (!projectId) {
    return (
      <EmptyState
        icon={CircleDot}
        title={t('review.issues.noProject', 'Select a project to view issues')}
      />
    );
  }
  return <ProjectIssues projectId={projectId} visible={visible} />;
}

function ProjectIssues({ projectId, visible }: IssuesTabProps & { projectId: string }) {
  const { t } = useTranslation();
  const startNewThreadFromIssue = useUIStore((s) => s.startNewThreadFromIssue);
  const [state, setState] = useState<IssueState>('open');
  // Filters belong to the project: switching projects starts without any.
  const [filters, setFilters] = useResettableState<IssueFilterState>(EMPTY_ISSUE_FILTERS, [
    projectId,
  ]);
  const filterOptions = useIssueFilterOptions(projectId, !!visible);
  const [selectedIssue, setSelectedIssue] = useState<EnrichedGitHubIssue | null>(null);
  const factory = useIssueFactory(projectId);

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
  const selection = useIssueSelection(list.items, factory, [projectId, state, filters]);

  const handleCreateThread = useCallback(
    (issue: EnrichedGitHubIssue) => {
      if (!repoInfo) return;
      startNewThreadFromIssue(projectId, {
        prompt: buildIssueThreadPrompt(issue, repoInfo),
        branchName: issue.suggestedBranchName,
        title: issue.title,
      });
    },
    [projectId, repoInfo, startNewThreadFromIssue],
  );

  // Clicking a label chip on a row toggles that label in the Labels filter, the
  // same value the filter bar's multi-select sets.
  const toggleLabel = useCallback(
    (name: string) =>
      setFilters((current) => ({
        ...current,
        labels: current.labels.includes(name)
          ? current.labels.filter((l) => l !== name)
          : [...current.labels, name],
      })),
    [setFilters],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="issues-tab">
      <IssuesToolbar
        loading={list.loading}
        onRefresh={list.refresh}
        repoInfo={repoInfo}
        count={list.items.length}
      />
      {/* While issues are selected, their actions take the filters' place. */}
      {selection.selected.length > 0 ? (
        <IssuesSelectionBar
          projectId={projectId}
          factory={factory}
          selected={selection.selected}
          sendable={selection.sendable}
          labelsOf={(n) =>
            list.items.find((issue) => issue.number === n)?.labels.map((label) => label.name) ?? []
          }
          onSent={selection.leave}
          onDeleted={(deleted) => {
            selection.leave(deleted);
            if (deleted.length > 0) list.refresh();
          }}
          onClear={selection.clear}
          leading={<IssuesSelectAll selection={selection} />}
        />
      ) : (
        <IssueFilterBar
          value={filters}
          onChange={setFilters}
          options={filterOptions.options}
          optionsLoading={filterOptions.loading}
          state={state}
          onStateChange={setState}
          leading={<IssuesSelectAll selection={selection} />}
        />
      )}
      <IssuesBody
        projectId={projectId}
        factory={factory}
        selected={selection.selected}
        onToggle={selection.toggle}
        issues={list.items}
        loading={list.loading}
        error={list.error}
        state={state}
        filtered={hasActiveIssueFilters(filters)}
        activeLabels={filters.labels}
        onToggleLabel={toggleLabel}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
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

/** The empty list's title: no issue matches the filters, or there are none in this state. */
function emptyIssuesTitle(t: TFunction, filtered: boolean, state: IssueState): string {
  if (filtered) return t('review.issues.noMatchingIssues', 'No issues match these filters');
  return state === 'open'
    ? t('review.issues.noOpenIssues', 'No open issues')
    : t('review.issues.noClosedIssues', 'No closed issues');
}

function IssuesError({ error }: { error: string }) {
  const { t } = useTranslation();
  return (
    <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center px-4 py-12 text-center text-sm">
      <p>{t('issues.error', 'Failed to load issues')}</p>
      <p className="mt-1 text-xs">{error}</p>
    </div>
  );
}

function IssuesBody({
  projectId,
  factory,
  selected,
  onToggle,
  issues,
  loading,
  error,
  state,
  filtered,
  activeLabels,
  onToggleLabel,
  hasMore,
  onLoadMore,
  onOpenIssue,
}: {
  projectId: string;
  factory: IssueFactory;
  selected: number[];
  onToggle: (issueNumber: number) => void;
  issues: EnrichedGitHubIssue[];
  loading: boolean;
  error: string | null;
  state: IssueState;
  /** A filter is set: the empty state says no issue matches, not that there are none. */
  filtered: boolean;
  /** Labels currently filtered on, so a row's active label chips show pressed. */
  activeLabels: readonly string[];
  /** Toggle a label in the Labels filter when its chip on a row is clicked. */
  onToggleLabel: (name: string) => void;
  hasMore: boolean;
  onLoadMore: () => void;
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
    return <IssuesError error={error} />;
  }
  if (issues.length === 0) {
    return <EmptyState icon={CircleDot} title={emptyIssuesTitle(t, filtered, state)} />;
  }
  return (
    <IssuesList
      projectId={projectId}
      factory={factory}
      selected={selected}
      onToggle={onToggle}
      issues={issues}
      loading={loading}
      activeLabels={activeLabels}
      onToggleLabel={onToggleLabel}
      hasMore={hasMore}
      onLoadMore={onLoadMore}
      onOpenIssue={onOpenIssue}
    />
  );
}

/** The most issues one selection takes: what one send or one delete accepts. */
const MAX_SELECTED = Math.min(MAX_ISSUES_PER_SEND, MAX_ISSUES_PER_DELETE);

interface IssueSelection {
  /** The selected issues that can still be selected. */
  selected: number[];
  /** The selected issues that can go to the factory. */
  sendable: number[];
  /** The listed issues a checkbox could select now. */
  selectable: number[];
  toggle: (issueNumber: number) => void;
  /** Select every selectable issue (up to MAX_SELECTED), or none if all are selected. */
  toggleAll: () => void;
  /** Drop these issues from the selection (sent or deleted). */
  leave: (gone: number[]) => void;
  clear: () => void;
}

/**
 * The selection that is sent to the factory (change factory-manual-queue) or
 * deleted. It starts empty again when the project, the state or a filter changes.
 */
function useIssueSelection(
  issues: EnrichedGitHubIssue[],
  factory: IssueFactory,
  resetKeys: readonly unknown[],
): IssueSelection {
  const [selected, setSelected] = useResettableState<number[]>([], resetKeys);
  // One send or delete takes at most MAX_SELECTED issues: past that, a checkbox adds nothing.
  const toggle = useCallback(
    (n: number) =>
      setSelected((current) => {
        if (current.includes(n)) return current.filter((x) => x !== n);
        return current.length < MAX_SELECTED ? [...current, n] : current;
      }),
    [setSelected],
  );
  const selectable = issues.flatMap((issue) =>
    canSelectIssue(factory, issue) ? [issue.number] : [],
  );
  // A selected issue that can no longer be selected (it entered the factory,
  // or left the list) leaves the selection for good, so it does not come back
  // if its run is cancelled.
  const kept = selected.filter((n) => selectable.includes(n));
  if (kept.length !== selected.length) setSelected(kept);
  const sendable = kept.filter((n) => {
    const issue = issues.find((i) => i.number === n);
    return issue ? canSendIssue(factory, issue) : false;
  });
  const allSelected = kept.length > 0 && kept.length >= Math.min(selectable.length, MAX_SELECTED);
  return {
    selected: kept,
    sendable,
    selectable,
    toggle,
    toggleAll: () => setSelected(allSelected ? [] : selectable.slice(0, MAX_SELECTED)),
    leave: (gone) => setSelected((current) => current.filter((n) => !gone.includes(n))),
    clear: () => setSelected([]),
  };
}

/**
 * The checkbox before the filters (or the selection's actions) that selects
 * every issue of the list a checkbox could select, in the rows' checkbox column.
 */
function IssuesSelectAll({ selection }: { selection: IssueSelection }) {
  const { t } = useTranslation();
  if (selection.selectable.length === 0) return null;
  const count = selection.selected.length;
  const state =
    count === 0
      ? 'unchecked'
      : count >= Math.min(selection.selectable.length, MAX_SELECTED)
        ? 'checked'
        : 'indeterminate';
  return (
    <span className="icon-base ml-1 grid shrink-0 place-items-center">
      <TriCheckbox
        state={state}
        onToggle={selection.toggleAll}
        aria-label={t('issues.selectAll', 'Select all issues')}
        data-testid="issues-select-all"
      />
    </span>
  );
}

/** The issues, plus their state in the caller's factory and their selection checkbox. */
function IssuesList({
  projectId,
  factory,
  selected,
  onToggle,
  issues,
  loading,
  activeLabels,
  onToggleLabel,
  hasMore,
  onLoadMore,
  onOpenIssue,
}: {
  projectId: string;
  factory: IssueFactory;
  selected: number[];
  onToggle: (issueNumber: number) => void;
  issues: EnrichedGitHubIssue[];
  loading: boolean;
  activeLabels: readonly string[];
  onToggleLabel: (name: string) => void;
  hasMore: boolean;
  onLoadMore: () => void;
  onOpenIssue: (issue: EnrichedGitHubIssue) => void;
}) {
  const now = useMinuteTick();

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
              selected={selected.includes(issue.number)}
              onToggle={onToggle}
              onOpen={onOpenIssue}
              activeLabels={activeLabels}
              onToggleLabel={onToggleLabel}
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
  activeLabels,
  onToggleLabel,
}: {
  projectId: string;
  issue: EnrichedGitHubIssue;
  now: number;
  factory: IssueFactory;
  selected: boolean;
  onToggle: (issueNumber: number) => void;
  onOpen: (issue: EnrichedGitHubIssue) => void;
  activeLabels: readonly string[];
  onToggleLabel: (name: string) => void;
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
              <IssueLabelBadges
                issue={issue}
                plain
                className="ml-1 align-middle"
                activeLabels={activeLabels}
                onLabelClick={onToggleLabel}
              />
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
