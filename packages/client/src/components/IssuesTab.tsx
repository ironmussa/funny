import type { EnrichedGitHubIssue } from '@funny/shared';
import { MAX_ISSUES_PER_SEND } from '@funny/shared/contracts/factory';
import { CircleCheck, CircleDot, ExternalLink, MessageSquare, Plus } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { GitHubProjectGate } from '@/components/GitHubProjectGate';
import { IssueLabelBadges, IssueLinkBadges } from '@/components/IssueBadges';
import { IssueDetailDialog } from '@/components/IssueDetailDialog';
import {
  canSendIssue,
  IssueFactoryStatus,
  IssuesFactoryBar,
  IssuesFactoryUnavailable,
  IssueSelectToggle,
  useIssueFactory,
  type IssueFactory,
} from '@/components/issues/IssueFactoryControls';
import { LoadMoreSentinel } from '@/components/LoadMoreSentinel';
import {
  TabToolbar,
  TabToolbarExternalLink,
  TabToolbarRefresh,
  TabToolbarSpacer,
} from '@/components/review-pane/TabToolbar';
import { ToolbarCount } from '@/components/review-pane/ToolbarCount';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Select, SelectContent, SelectItem, SelectTrigger } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useGitHubProjectId } from '@/hooks/use-github-project-id';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { usePagedGitHubList, type FetchGitHubListPage } from '@/hooks/use-paged-github-list';
import { api } from '@/lib/api';
import { buildIssueThreadPrompt } from '@/lib/build-issue-thread-prompt';
import { createClientLogger } from '@/lib/client-logger';
import {
  listRowActionClassName,
  listRowClassName,
  listRowTitleClassName,
} from '@/lib/list-row-styles';
import { cn } from '@/lib/utils';
import { useUIStore } from '@/stores/ui-store';

const log = createClientLogger('issues-tab');

type IssueState = 'open' | 'closed';

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
  const [selectedIssue, setSelectedIssue] = useState<EnrichedGitHubIssue | null>(null);

  const fetchPage = useMemo<FetchGitHubListPage<EnrichedGitHubIssue> | null>(() => {
    if (!projectId) return null;
    return (page, signal, cursor) =>
      api
        .githubIssuesEnriched(projectId, { state, page, per_page: 30, cursor }, signal)
        .map((data) => ({ ...data, items: data.issues }))
        .mapErr((error) => {
          if (!signal.aborted) {
            log.error('failed to load issues', { projectId, state, error: error.message });
          }
          return error;
        });
  }, [projectId, state]);

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
        state={state}
        onStateChange={setState}
        repoInfo={repoInfo}
        count={list.items.length}
      />
      <IssuesBody
        projectId={projectId}
        issues={list.items}
        loading={list.loading}
        error={list.error}
        state={state}
        hasMore={list.hasMore}
        onLoadMore={list.loadMore}
        onCreateThread={handleCreateThread}
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
  state,
  onStateChange,
  repoInfo,
  count,
}: {
  loading: boolean;
  onRefresh: () => void;
  state: IssueState;
  onStateChange: (state: IssueState) => void;
  repoInfo: { owner: string; repo: string } | null;
  count: number;
}) {
  const { t } = useTranslation();
  const stateLabel = (s: IssueState): string =>
    s === 'open' ? t('issues.open', 'Open') : t('issues.closed', 'Closed');

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

      <Select
        value={state}
        onValueChange={(v) => {
          if (v === 'open' || v === 'closed') onStateChange(v);
        }}
      >
        <SelectTrigger size="xs" className="w-auto gap-1" data-testid="issues-state-trigger">
          <CircleDot className="icon-xs opacity-70" />
          <span>{stateLabel(state)}</span>
        </SelectTrigger>
        <SelectContent>
          {(['open', 'closed'] satisfies IssueState[]).map((s) => (
            <SelectItem key={s} value={s} className="text-xs" data-testid={`issues-filter-${s}`}>
              {stateLabel(s)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

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
  hasMore,
  onLoadMore,
  onCreateThread,
  onOpenIssue,
}: {
  projectId: string;
  issues: EnrichedGitHubIssue[];
  loading: boolean;
  error: string | null;
  state: IssueState;
  hasMore: boolean;
  onLoadMore: () => void;
  onCreateThread: (issue: EnrichedGitHubIssue) => void;
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
          state === 'open'
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
      onCreateThread={onCreateThread}
      onOpenIssue={onOpenIssue}
    />
  );
}

/**
 * The issues, plus their state in the caller's factory and the selection sent
 * to it (change factory-manual-queue).
 */
function IssuesList({
  projectId,
  issues,
  loading,
  hasMore,
  onLoadMore,
  onCreateThread,
  onOpenIssue,
}: {
  projectId: string;
  issues: EnrichedGitHubIssue[];
  loading: boolean;
  hasMore: boolean;
  onLoadMore: () => void;
  onCreateThread: (issue: EnrichedGitHubIssue) => void;
  onOpenIssue: (issue: EnrichedGitHubIssue) => void;
}) {
  const now = useMinuteTick();
  const factory = useIssueFactory(projectId);
  const [selected, setSelected] = useState<number[]>([]);
  // One send takes at most MAX_ISSUES_PER_SEND issues: past that, a checkbox adds nothing.
  const toggle = useCallback(
    (n: number) =>
      setSelected((current) => {
        if (current.includes(n)) return current.filter((x) => x !== n);
        return current.length < MAX_ISSUES_PER_SEND ? [...current, n] : current;
      }),
    [],
  );
  // A selected issue that can no longer be sent (it entered the factory) leaves
  // the selection for good, so it does not come back if its run is cancelled.
  const sendable = selected.filter((n) => {
    const issue = issues.find((i) => i.number === n);
    return issue ? canSendIssue(factory, issue) : false;
  });
  if (sendable.length !== selected.length) setSelected(sendable);

  return (
    <>
      {factory.unavailable && <IssuesFactoryUnavailable projectId={projectId} />}
      {factory.settings && sendable.length > 0 && (
        <IssuesFactoryBar
          projectId={projectId}
          settings={factory.settings}
          selected={sendable}
          onSent={(accepted) =>
            setSelected((current) => current.filter((n) => !accepted.includes(n)))
          }
          onClear={() => setSelected([])}
        />
      )}
      <ScrollArea className="min-h-0 flex-1">
        <div className="divide-sidebar-border divide-y">
          {issues.map((issue) => (
            <IssueRow
              key={issue.number}
              projectId={projectId}
              issue={issue}
              now={now}
              factory={factory}
              selected={sendable.includes(issue.number)}
              onToggle={toggle}
              onCreateThread={onCreateThread}
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
  onCreateThread,
  onOpen,
}: {
  projectId: string;
  issue: EnrichedGitHubIssue;
  now: number;
  factory: IssueFactory;
  selected: boolean;
  onToggle: (issueNumber: number) => void;
  onCreateThread: (issue: EnrichedGitHubIssue) => void;
  onOpen: (issue: EnrichedGitHubIssue) => void;
}) {
  const { t } = useTranslation();
  const factoryRun = factory.active ? factory.latestRun.get(issue.number) : undefined;
  return (
    <div className={listRowClassName} data-testid={`issue-item-${issue.number}`}>
      {canSendIssue(factory, issue) ? (
        <IssueSelectToggle
          issueNumber={issue.number}
          icon={<IssueStateIcon state={issue.state} className="icon-base" />}
          checked={selected}
          onToggle={onToggle}
        />
      ) : (
        <IssueStateIcon state={issue.state} className="icon-base mt-0.5 shrink-0" />
      )}
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <button
          type="button"
          onClick={() => onOpen(issue)}
          className={cn(
            listRowTitleClassName,
            'hover:text-primary line-clamp-2 cursor-pointer text-left transition-colors',
          )}
          data-testid={`issue-title-${issue.number}`}
        >
          {issue.title}
        </button>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-muted-foreground text-xs">#{issue.number}</span>
          <span className="text-muted-foreground text-xs">{timeAgo(issue.created_at, now)}</span>
          {issue.user && <span className="text-muted-foreground text-xs">{issue.user.login}</span>}
          {issue.comments > 0 && (
            <span className="text-muted-foreground flex items-center gap-0.5 text-xs">
              <MessageSquare className="icon-xs" />
              {issue.comments}
            </span>
          )}
        </div>
        {/* The linked branch and pull request on one line… */}
        <div
          className="flex flex-wrap items-center gap-1.5 empty:hidden"
          data-testid={`issue-links-${issue.number}`}
        >
          <IssueLinkBadges issue={issue} />
        </div>
        {/* …the issue's state in the factory on its own line… */}
        {factoryRun && (
          <div
            className="flex items-center gap-1.5"
            data-testid={`issue-factory-line-${issue.number}`}
          >
            <IssueFactoryStatus
              projectId={projectId}
              run={factoryRun}
              position={factory.queuePosition.get(issue.number)}
            />
          </div>
        )}
        {/* …and the GitHub labels on another. */}
        <div
          className="flex flex-wrap items-center gap-1.5 empty:hidden"
          data-testid={`issue-tags-${issue.number}`}
        >
          <IssueLabelBadges issue={issue} />
        </div>
        {issue.body ? (
          <p
            className="text-muted-foreground mt-1 line-clamp-3 text-xs whitespace-pre-wrap"
            data-testid={`issue-body-${issue.number}`}
          >
            {issue.body}
          </p>
        ) : null}
      </div>

      <ButtonGroup data-testid={`issue-actions-${issue.number}`}>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              asChild
              // oxlint-disable-next-line shadcn/require-static-classes -- listRowActionClassName is a static constant from list-row-styles
              className={listRowActionClassName}
              data-testid={`issue-open-github-${issue.number}`}
            >
              <a
                href={issue.html_url}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={t('issues.viewOnGithub', 'View on GitHub')}
              >
                <ExternalLink className="icon-sm" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">{t('issues.viewOnGithub', 'View on GitHub')}</TooltipContent>
        </Tooltip>
        {!issue.linkedBranch && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={t('issues.createThread', 'Create thread')}
                // oxlint-disable-next-line shadcn/require-static-classes -- listRowActionClassName is a static constant from list-row-styles
                className={listRowActionClassName}
                onClick={() => onCreateThread(issue)}
                data-testid={`issue-create-thread-${issue.number}`}
              >
                <Plus className="icon-sm" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('issues.createThread', 'Create thread')}</TooltipContent>
          </Tooltip>
        )}
      </ButtonGroup>
    </div>
  );
}
