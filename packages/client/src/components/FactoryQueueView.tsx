/**
 * The factory view (`/factory`): every run of the caller's issue factories,
 * across projects, that has not ended or ended in the last two weeks — ordered
 * as waiting for the member, in progress, in the queue, failed and ended
 * (merged or stopped). Laid out like the
 * global search view (search bar and a status filter on top, one row per run
 * with its thread's status icon); a row opens the run's last agent thread, and
 * carries the run's controls (PR, retry, stop).
 */
import { Clock, Factory } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FilterDropdown } from '@/components/all-threads/FilterDropdown';
import { FactoryRunControls } from '@/components/thread/FactoryRunControls';
import { ThreadStatusPin } from '@/components/thread/ThreadStatusPin';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import { useFactoryQueueRuns } from '@/data/factory/hooks';
import { useProjects } from '@/data/projects/hooks';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import type { FactoryQueueRun, FactoryRun } from '@/lib/api/factory';
import {
  FACTORY_QUEUE_SECTIONS,
  factoryRunStateLabel,
  factoryRunStateVariant,
  factoryWaitReasonText,
  groupFactoryRuns,
} from '@/lib/factory-run-labels';
import { useThreadById } from '@/lib/thread-selectors';
import { timeAgo } from '@/lib/thread-utils';
import { getThreadRoute } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';

interface RowProps {
  run: FactoryQueueRun;
  projectName: string | undefined;
  now: number;
}

const FactoryRunRow = memo(function FactoryRunRow({ run, projectName, now }: RowProps) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const lastThreadId = run.threadIds.at(-1);
  const thread = useThreadById(lastThreadId);
  const title =
    thread?.title ||
    t('factoryView.issueTitle', 'Issue #{{number}}', {
      number: run.issueNumber,
    });
  const detail =
    run.state === 'requested' && run.waitReason
      ? factoryWaitReasonText(t, run.waitReason)
      : run.state === 'failed'
        ? run.failureReason
        : run.currentStep;
  const open = () => {
    if (!lastThreadId) return;
    navigate(
      buildPath(getThreadRoute({ id: lastThreadId, projectId: run.projectId, isScratch: false })),
    );
  };

  return (
    <li
      className="group/row text-muted-foreground hover:bg-accent/50 hover:text-foreground flex items-center gap-1.5 rounded-md py-1.5 pr-3 pl-2"
      data-testid={`factory-view-run-${run.id}`}
    >
      <span className="flex w-4 shrink-0 justify-center self-start pt-0.5">
        {thread ? (
          <ThreadStatusPin thread={thread} hoverGroup="row" showStatusTooltip />
        ) : (
          <Clock className="icon-sm text-muted-foreground" />
        )}
      </span>
      <button
        type="button"
        className={cn(
          'flex min-w-0 flex-1 flex-col items-start gap-0.5 text-left',
          !lastThreadId && 'cursor-default',
        )}
        disabled={!lastThreadId}
        onClick={open}
        data-testid={`factory-view-open-${run.id}`}
      >
        <span className="text-foreground w-full truncate text-sm">{title}</span>
        <span className="text-muted-foreground flex w-full min-w-0 items-center gap-1.5 text-xs">
          {projectName && <span className="shrink-0">{projectName}</span>}
          <span className="shrink-0">/</span>
          <span className="shrink-0">#{run.issueNumber}</span>
          <Badge size="xs" variant={factoryRunStateVariant(run.state)} className="shrink-0">
            {factoryRunStateLabel(t, run.state)}
          </Badge>
          {detail && <span className="truncate">{detail}</span>}
        </span>
      </button>
      <span className="flex shrink-0 items-center gap-1">
        <FactoryRunControls
          projectId={run.projectId}
          run={run}
          testId={(button) => `factory-view-${button}-${run.id}`}
        />
      </span>
      <span className="text-muted-foreground w-10 shrink-0 text-right text-xs">
        {timeAgo(run.admittedAt ?? run.startedAt, t, now)}
      </span>
    </li>
  );
});

/** The run states, in the order the status filter lists them. */
const STATE_ORDER: readonly FactoryRun['state'][] = [
  'waiting_human',
  'requested',
  'queued',
  'working',
  'pr_open',
  'waiting_ci',
  'fixing',
  'failed',
  'merged',
  'stopped',
];

export function FactoryQueueView() {
  const { t } = useTranslation();
  const runs = useFactoryQueueRuns();
  const projects = useProjects();
  const now = useMinuteTick();
  const [search, setSearch] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [stateFilter, setStateFilter] = useState<Set<string>>(() => new Set());

  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  const stateCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const run of runs ?? []) counts[run.state] = (counts[run.state] ?? 0) + 1;
    return counts;
  }, [runs]);

  /** Runs in the view's order: waiting for the member, in progress, in the queue, failed, ended. */
  const filtered = useMemo(() => {
    if (!runs) return undefined;
    const raw = search.trim().replace(/^#/, '');
    const needle = caseSensitive ? raw : raw.toLowerCase();
    const matches = (text: string) => (caseSensitive ? text : text.toLowerCase()).includes(needle);
    const kept = runs.filter(
      (run) =>
        (stateFilter.size === 0 || stateFilter.has(run.state)) &&
        (!needle ||
          String(run.issueNumber).includes(needle) ||
          matches(projectNameById.get(run.projectId) ?? '') ||
          matches(run.currentStep ?? '')),
    );
    const groups = groupFactoryRuns(kept);
    return FACTORY_QUEUE_SECTIONS.flatMap((section) => groups[section]);
  }, [runs, search, caseSensitive, stateFilter, projectNameById]);

  const toggleState = (state: string) =>
    setStateFilter((prev) => {
      const next = new Set(prev);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });

  const hasActiveFilters = stateFilter.size > 0;
  const projectCount = runs ? new Set(runs.map((run) => run.projectId)).size : 0;

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col" data-testid="factory-view">
      <div className="border-border flex items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Factory className="icon-sm text-muted-foreground" />
            {t('factoryView.title', 'Factory queue')}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t('factoryView.summary', '{{projects}} projects · {{runs}} runs', {
              projects: projectCount,
              runs: runs?.length ?? 0,
            })}
          </p>
        </div>
      </div>

      <div className="border-border/50 flex items-center gap-2 border-b px-4 py-2">
        <SearchBar
          query={search}
          onQueryChange={setSearch}
          totalMatches={filtered?.length ?? 0}
          resultLabel={search.trim() ? `${filtered?.length ?? 0}/${runs?.length ?? 0}` : ''}
          caseSensitive={caseSensitive}
          onCaseSensitiveChange={setCaseSensitive}
          onClose={search ? () => setSearch('') : undefined}
          autoFocus={false}
          placeholder={t('factoryView.searchPlaceholder', 'Filter by issue, project or step')}
          testIdPrefix="factory-view-search"
          className="border-input h-7 w-72 shrink-0 rounded-md border bg-transparent px-2"
        />

        <div className="bg-border h-4 w-px" />

        <FilterDropdown
          testId="factory-view-status-filter"
          label={t('allThreads.filterStatus')}
          options={STATE_ORDER.map((state) => ({
            value: state,
            label: factoryRunStateLabel(t, state),
          }))}
          selected={stateFilter}
          onToggle={toggleState}
          counts={stateCounts}
        />

        {hasActiveFilters && (
          <button
            type="button"
            data-testid="factory-view-clear-filters"
            onClick={() => setStateFilter(new Set())}
            className="text-muted-foreground hover:text-foreground px-2 py-1 text-xs whitespace-nowrap transition-colors"
          >
            {t('allThreads.clearFilters')}
          </button>
        )}
      </div>

      {!filtered ? (
        <LoadingState testId="factory-view-loading" />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={Factory}
          title={t('factoryView.empty', 'Nothing in the factory')}
          description={t(
            'factoryView.emptyDescription',
            'Issues sent to a project factory show here while they wait and run.',
          )}
          testId="factory-view-empty"
        />
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <ul className="flex flex-col gap-0.5 p-2" data-testid="factory-view-list">
            {filtered.map((run) => (
              <FactoryRunRow
                key={run.id}
                run={run}
                projectName={projectNameById.get(run.projectId)}
                now={now}
              />
            ))}
          </ul>
        </ScrollArea>
      )}
    </div>
  );
}
