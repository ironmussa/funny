import type { ActionJob, ActionRun, CICheck, PRDetail } from '@funny/shared';
import {
  ChevronRight,
  CircleDashed,
  ExternalLink,
  GitPullRequest,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { CheckIcon, MergeStatus, ReviewDecisionBadge } from '@/components/PRSummaryCard';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { rerunFailedJobs } from '@/data/github-actions/actions';
import { useActionJobLog, useActionJobs, useActionRuns } from '@/data/github-actions/hooks';
import { refreshActionRuns } from '@/data/github-actions/queries';
import { usePRDetail, usePRPolling } from '@/data/pull-requests/hooks';
import { fetchPRDetail } from '@/data/pull-requests/queries';
import { createAnsiConverter } from '@/lib/ansi-to-html';
import { sortChecks } from '@/lib/ci-checks';
import {
  canRerunFailed,
  formatActionDuration,
  isFailed,
  jobDurationMs,
  repoActionsUrl,
  runDurationMs,
} from '@/lib/github-actions';
import {
  listRowActionClassName,
  listRowClassName,
  listRowTitleClassName,
} from '@/lib/list-row-styles';
import { shortTimeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

/**
 * The review pane's Actions tab: the repository's GitHub Actions runs (this
 * branch's, or every branch's), each run's jobs and steps, the end of a failed
 * job's log, and "re-run failed jobs". When the branch has a pull request, its
 * check summary (which also counts checks from apps other than Actions) sits on
 * top and opens into the full check list.
 */

type Scope = 'branch' | 'all';

interface ActionsTabProps {
  projectId: string;
  prNumber?: number;
  prUrl?: string;
  /** The branch the pane is on; without one the tab lists every branch. */
  currentBranch?: string;
  visible: boolean;
  /** A steer sharee sees the runs but cannot re-run them. */
  readOnly?: boolean;
}

export function ActionsTab({
  projectId,
  prNumber,
  prUrl,
  currentBranch,
  visible,
  readOnly = false,
}: ActionsTabProps) {
  const { t } = useTranslation();
  const [scope, setScope] = useState<Scope>('branch');
  const branch = scope === 'branch' && currentBranch ? currentBranch : null;
  const { page, loading, error, rateLimited } = useActionRuns(
    projectId || undefined,
    branch,
    visible,
  );
  usePRPolling(projectId || undefined, prNumber, visible);

  if (!projectId) {
    return (
      <EmptyState
        icon={GitPullRequest}
        title={t('review.actions.noProject', 'Select a project to view its workflow runs')}
      />
    );
  }

  const handleRefresh = () => {
    refreshActionRuns(projectId, branch);
    if (prNumber) void fetchPRDetail(projectId, prNumber, { force: true });
  };
  const runs = page?.runs ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="actions-tab">
      <div className="border-sidebar-border flex items-center gap-2 border-b px-3 py-1.5 text-xs">
        <ToggleGroup
          type="single"
          size="sm"
          value={branch ? 'branch' : 'all'}
          onValueChange={(value) => value && setScope(value as Scope)}
          className="h-6"
        >
          <ToggleGroupItem
            value="branch"
            disabled={!currentBranch}
            className="h-6 max-w-40 truncate px-2 text-xs"
            title={currentBranch}
            data-testid="actions-scope-branch"
          >
            {currentBranch ?? t('review.actions.thisBranch', 'This branch')}
          </ToggleGroupItem>
          <ToggleGroupItem value="all" className="h-6 px-2 text-xs" data-testid="actions-scope-all">
            {t('review.actions.allBranches', 'All branches')}
          </ToggleGroupItem>
        </ToggleGroup>
        <div className="min-w-0 flex-1" />
        <ActionsToolbar
          rateLimited={rateLimited}
          loading={loading}
          actionsUrl={repoActionsUrl(runs)}
          onRefresh={handleRefresh}
        />
      </div>

      {prNumber ? (
        <PRChecksSection projectId={projectId} prNumber={prNumber} prUrl={prUrl} />
      ) : null}

      <RunList
        projectId={projectId}
        runs={runs}
        loaded={page !== undefined}
        loading={loading}
        error={error}
        readOnly={readOnly}
        visible={visible}
      />
    </div>
  );
}

function RunList({
  projectId,
  runs,
  loaded,
  loading,
  error,
  readOnly,
  visible,
}: {
  projectId: string;
  runs: ActionRun[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
  readOnly: boolean;
  visible: boolean;
}) {
  const { t } = useTranslation();
  if (!loaded && loading) {
    return (
      <LoadingState
        testId="actions-loading"
        label={t('review.actions.loading', 'Loading workflow runs…')}
      />
    );
  }
  if (!loaded && error) {
    return (
      <EmptyState
        icon={CircleDashed}
        title={t('review.actions.loadFailed', 'Could not load workflow runs')}
        description={error}
      />
    );
  }
  if (runs.length === 0) {
    return (
      <EmptyState icon={CircleDashed} title={t('review.actions.noRuns', 'No workflow runs')} />
    );
  }
  return (
    <ScrollArea className="flex min-h-0 flex-1 flex-col">
      <div className="divide-sidebar-border flex flex-col divide-y" data-testid="actions-runs-list">
        {runs.map((run) => (
          <RunRow
            key={run.id}
            projectId={projectId}
            run={run}
            readOnly={readOnly}
            visible={visible}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

// ── PR checks ───────────────────────────────────────────────

function PRChecksSection({
  projectId,
  prNumber,
  prUrl,
}: {
  projectId: string;
  prNumber: number;
  prUrl?: string;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const { detail } = usePRDetail(projectId, prNumber);
  const checks = detail ? sortChecks(detail.checks) : [];

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-sidebar-border border-b">
      <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-center gap-2 text-left"
            data-testid="actions-pr-checks-toggle"
          >
            <ChevronRight
              className={cn(
                'icon-sm text-muted-foreground shrink-0 transition-transform',
                open && 'rotate-90',
              )}
            />
            <GitPullRequest className="icon-sm text-muted-foreground shrink-0" />
            <span className="shrink-0 font-medium">#{prNumber}</span>
            {detail && checks.length > 0 ? (
              <CISummaryCounts detail={detail} total={checks.length} />
            ) : (
              <span className="text-muted-foreground truncate">
                {t('review.ci.noChecks', 'No CI checks reported for this PR')}
              </span>
            )}
          </button>
        </CollapsibleTrigger>
        {detail && <ReviewDecisionBadge decision={detail.review_decision} />}
        {detail && <MergeStatus mergeable={detail.mergeable_state} merged={detail.merged} />}
        {prUrl && (
          <a
            href={prUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('review.ci.openOnGithub', 'Open PR on GitHub')}
            className="text-muted-foreground hover:text-foreground shrink-0"
            data-testid="actions-pr-open-github"
          >
            <ExternalLink className="size-3" />
          </a>
        )}
      </div>
      <CollapsibleContent>
        {open && (
          <div className="flex flex-col pb-1" data-testid="ci-checks-list">
            {checks.map((check) => (
              <CICheckRow key={check.id} check={check} />
            ))}
          </div>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

function CISummaryCounts({ detail, total }: { detail: PRDetail; total: number }) {
  const { t } = useTranslation();
  return (
    <span className="truncate font-medium" data-testid="ci-summary-counts">
      {t('review.ci.passedCount', '{{passed}}/{{total}} passed', {
        passed: detail.checks_passed,
        total,
      })}
      {detail.checks_failed > 0 && (
        <span className="ml-1.5 text-red-400">
          {t('review.ci.failedCount', '{{count}} failed', { count: detail.checks_failed })}
        </span>
      )}
      {detail.checks_pending > 0 && (
        <span className="ml-1.5 text-yellow-400">
          {t('review.ci.pendingCount', '{{count}} pending', { count: detail.checks_pending })}
        </span>
      )}
    </span>
  );
}

function CICheckRow({ check }: { check: CICheck }) {
  return (
    <div
      className="flex items-center gap-2 py-1 pr-3 pl-9 text-xs"
      data-testid={`ci-check-${check.id}`}
    >
      <CheckIcon check={check} />
      <span className="truncate">{check.name}</span>
      {check.app_name && <span className="text-muted-foreground shrink-0">({check.app_name})</span>}
      {check.html_url && (
        <a
          href={check.html_url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Open ${check.name} check details`}
          className="text-muted-foreground hover:text-foreground ml-auto shrink-0"
          data-testid={`ci-check-link-${check.id}`}
        >
          <ExternalLink className="size-3" />
        </a>
      )}
    </div>
  );
}

// ── Runs ────────────────────────────────────────────────────

function RunRow({
  projectId,
  run,
  readOnly,
  visible,
}: {
  projectId: string;
  run: ActionRun;
  readOnly: boolean;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [rerunning, setRerunning] = useState(false);
  const duration = runDurationMs(run);
  const meta = [
    `${run.name} #${run.run_number}`,
    run.event,
    run.head_branch,
    run.head_sha.slice(0, 7),
    duration !== null ? formatActionDuration(duration) : null,
  ].filter(Boolean);

  const handleRerun = async () => {
    setRerunning(true);
    try {
      await rerunFailedJobs(projectId, run.id);
      toast.success(t('review.actions.rerunStarted', 'Re-running failed jobs'));
    } catch (error) {
      toast.error(
        t('review.actions.rerunFailed', 'Could not re-run: {{message}}', {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setRerunning(false);
    }
  };

  return (
    <Collapsible open={open} onOpenChange={setOpen} data-testid={`actions-run-${run.id}`}>
      <div className={cn(listRowClassName, 'items-center')}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex min-w-0 flex-1 items-start gap-2 text-left"
            data-testid={`actions-run-toggle-${run.id}`}
          >
            <span className="mt-1">
              <CheckIcon check={run} />
            </span>
            <span className="flex min-w-0 flex-col">
              <span className={cn(listRowTitleClassName, 'truncate')} title={run.display_title}>
                {run.display_title}
              </span>
              <span className="text-muted-foreground truncate">{meta.join(' · ')}</span>
            </span>
          </button>
        </CollapsibleTrigger>
        <span className="text-muted-foreground shrink-0 tabular-nums">
          {shortTimeAgo(run.created_at)}
        </span>
        {!readOnly && canRerunFailed(run) && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={() => void handleRerun()}
                disabled={rerunning}
                className={listRowActionClassName}
                aria-label={t('review.actions.rerun', 'Re-run failed jobs')}
                data-testid={`actions-run-rerun-${run.id}`}
              >
                <RotateCcw className={cn('icon-sm', rerunning && 'animate-spin')} />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('review.actions.rerun', 'Re-run failed jobs')}</TooltipContent>
          </Tooltip>
        )}
        <a
          href={run.html_url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('review.actions.openRun', 'Open run on GitHub')}
          className={listRowActionClassName}
          data-testid={`actions-run-open-${run.id}`}
        >
          <ExternalLink className="icon-sm" />
        </a>
      </div>
      <CollapsibleContent>
        {open && <RunJobs projectId={projectId} run={run} visible={visible} />}
      </CollapsibleContent>
    </Collapsible>
  );
}

function RunJobs({
  projectId,
  run,
  visible,
}: {
  projectId: string;
  run: ActionRun;
  visible: boolean;
}) {
  const { t } = useTranslation();
  const { jobs, loading, error } = useActionJobs(projectId, run, visible);
  if (!jobs) {
    return (
      <div
        className="text-muted-foreground px-9 pb-2 text-xs"
        data-testid={`actions-jobs-${run.id}`}
      >
        {error ?? (loading ? t('review.actions.loadingJobs', 'Loading jobs…') : null)}
      </div>
    );
  }
  return (
    <div className="flex flex-col pb-2" data-testid={`actions-jobs-${run.id}`}>
      {jobs.map((job) => (
        <JobRow key={job.id} projectId={projectId} job={job} />
      ))}
    </div>
  );
}

function JobRow({ projectId, job }: { projectId: string; job: ActionJob }) {
  const { t } = useTranslation();
  const [showLog, setShowLog] = useState(false);
  const failed = isFailed(job);
  const duration = jobDurationMs(job);
  const failedSteps = failed ? job.steps.filter(isFailed) : [];

  return (
    <div className="flex flex-col text-xs" data-testid={`actions-job-${job.id}`}>
      <div className="flex items-center gap-2 py-1 pr-3 pl-9">
        <CheckIcon check={job} />
        <span className="truncate">{job.name}</span>
        {duration !== null && (
          <span className="text-muted-foreground shrink-0 tabular-nums">
            {formatActionDuration(duration)}
          </span>
        )}
        <div className="min-w-0 flex-1" />
        {failed && (
          <Button
            variant="ghost"
            size="xs"
            onClick={() => setShowLog((v) => !v)}
            className="text-muted-foreground h-5 shrink-0 px-1.5"
            data-testid={`actions-job-log-toggle-${job.id}`}
          >
            {showLog
              ? t('review.actions.hideLog', 'Hide log')
              : t('review.actions.showLog', 'Show log')}
          </Button>
        )}
      </div>
      {failedSteps.map((step) => (
        <div
          key={step.number}
          className="text-muted-foreground flex items-center gap-2 py-0.5 pr-3 pl-14"
          data-testid={`actions-job-${job.id}-failed-step-${step.number}`}
        >
          <CheckIcon check={step} />
          <span className="truncate">{step.name}</span>
        </div>
      ))}
      {showLog && <JobLog projectId={projectId} jobId={job.id} />}
    </div>
  );
}

/** Job logs carry the tool's own colors; the converter escapes HTML. */
const logConverter = createAnsiConverter({
  fg: 'hsl(var(--muted-foreground))',
  bg: 'transparent',
  newline: false,
});

function JobLog({ projectId, jobId }: { projectId: string; jobId: number }) {
  const { t } = useTranslation();
  const { log, loading, error } = useActionJobLog(projectId, jobId);
  const html = useMemo(() => (log ? logConverter.toHtml(log.lines.join('\n')) : ''), [log]);
  if (!log) {
    return (
      <div className="text-muted-foreground py-1 pr-3 pl-14">
        {error ?? (loading ? t('review.actions.loadingLog', 'Loading log…') : null)}
      </div>
    );
  }
  return (
    <div className="py-1 pr-3 pl-9">
      {log.truncated && (
        <div className="text-muted-foreground pb-1">
          {t('review.actions.logTruncated', 'Showing the last lines up to the error')}
        </div>
      )}
      <pre
        className="bg-muted/40 text-muted-foreground max-h-80 overflow-auto rounded px-2 py-1 font-mono whitespace-pre-wrap"
        data-testid={`actions-job-log-${jobId}`}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}

// ── Toolbar ─────────────────────────────────────────────────

function ActionsToolbar({
  rateLimited,
  loading,
  actionsUrl,
  onRefresh,
}: {
  rateLimited: boolean;
  loading: boolean;
  actionsUrl: string | null;
  onRefresh: () => void;
}) {
  const { t } = useTranslation();
  return (
    <>
      {rateLimited && (
        <Tooltip>
          <TooltipTrigger>
            <span className="text-yellow-500">{t('review.ci.rateLimited', 'Rate limited')}</span>
          </TooltipTrigger>
          <TooltipContent>
            {t('review.ci.rateLimitedHint', 'GitHub API rate limit reached. Polling paused.')}
          </TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onRefresh}
            disabled={loading}
            className="text-muted-foreground shrink-0"
            data-testid="actions-refresh"
          >
            <RefreshCw className={cn('icon-base', loading && 'animate-spin')} />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{t('common.refresh', 'Refresh')}</TooltipContent>
      </Tooltip>
      {actionsUrl && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              asChild
              className="text-muted-foreground shrink-0"
              data-testid="actions-open-github"
            >
              <a href={actionsUrl} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="icon-base" />
              </a>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {t('review.actions.openOnGithub', 'Open Actions on GitHub')}
          </TooltipContent>
        </Tooltip>
      )}
    </>
  );
}
