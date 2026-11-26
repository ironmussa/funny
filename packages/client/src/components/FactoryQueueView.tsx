/**
 * The factory view (`/factory`): every run of the caller's issue factories,
 * across projects, that has not ended or ended in the last two weeks — ordered
 * as waiting for the member, in progress, in the queue, failed and ended
 * (merged or stopped). Laid out like the
 * global search view (search bar and a status filter on top, one row per run
 * with its thread's status icon); a row opens the run's last agent thread, and
 * carries the run's controls (PR, retry, stop). The board layout (openspec
 * factory-pipeline-board) shows the same filtered runs in stage columns, and
 * the analytics layout the factory's health and integration figures.
 */
import { implementingThreadOf } from '@funny/shared/contracts/factory';
import type { TFunction } from 'i18next';
import { Clock, Factory, PanelRight, Play } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FilterDropdown } from '@/components/all-threads/FilterDropdown';
import { useFactoryViewParams } from '@/components/factory-board/factory-view-params';
import { FactoryAnalytics } from '@/components/factory-board/FactoryAnalytics';
import { FactoryBoard } from '@/components/factory-board/FactoryBoard';
import {
  FactoryBulkActions,
  useFactoryRunSelection,
} from '@/components/factory-board/FactoryBulkActions';
import { FactoryIncidentBanners } from '@/components/factory-board/FactoryHealthHeader';
import { FactoryQueueActions } from '@/components/factory-board/FactoryQueueActions';
import {
  FactoryActiveToggle,
  FactoryBoardColumnsMenu,
  FactoryLayoutToggle,
} from '@/components/factory-board/FactoryViewToggles';
import { factoryRunDependencies } from '@/components/factory-board/run-dependencies';
import { FactoryRunDetail } from '@/components/factory-board/run-detail/FactoryRunDetail';
import { useSelectedFactoryRun } from '@/components/factory-board/use-selected-factory-run';
import { RunFactoryFlowDialog } from '@/components/factory-flows/RunFactoryFlowDialog';
import { FactoryRunControls } from '@/components/thread/FactoryRunControls';
import { ThreadStatusPin } from '@/components/thread/ThreadStatusPin';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { SearchBar } from '@/components/ui/search-bar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { useFactoryQueueRuns } from '@/data/factory/hooks';
import { useProjects } from '@/data/projects/hooks';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import type { FactoryQueueRun, FactoryRun } from '@/lib/api/factory';
import {
  factoryRunStateLabel,
  factoryRunStateVariant,
  factoryWaitReasonText,
  filterFactoryRuns,
  factoryRunTitle,
  factoryRunRef,
} from '@/lib/factory-run-labels';
import { useThreadById } from '@/lib/thread-selectors';
import { timeAgo } from '@/lib/thread-utils';
import { getThreadRoute } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';
import { cn } from '@/lib/utils';
import type { FactoryViewLayout } from '@/stores/factory-view-store';

interface RowProps {
  run: FactoryQueueRun;
  projectName: string | undefined;
  now: number;
  /** Opens the run's detail panel. */
  onSelect: (run: FactoryQueueRun) => void;
}

/** The row's second line: why it waits, why it failed, or the step it is on. */
function runDetail(t: TFunction, run: FactoryQueueRun): string | null {
  if (run.state === 'requested' && run.waitReason) return factoryWaitReasonText(t, run.waitReason);
  return run.state === 'failed' ? run.failureReason : run.currentStep;
}

const FactoryRunRow = memo(function FactoryRunRow({ run, projectName, now, onSelect }: RowProps) {
  const { t } = useTranslation();
  const navigate = useStableNavigate();
  const lastThreadId = implementingThreadOf(run);
  const thread = useThreadById(lastThreadId);
  const title = factoryRunTitle(t, run, thread?.title);
  const detail = runDetail(t, run);
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
      {/* `status-glyph-dots`: like a sidebar thread row, a dot theme (Minimal) shows dots here. */}
      <span className="status-glyph-dots flex w-4 shrink-0 justify-center self-start pt-0.5">
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
          <span className="shrink-0">{factoryRunRef(t, run)}</span>
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
        <TooltipIconButton
          size="icon-xs"
          variant="ghost"
          tooltip={t('factoryView.details', 'Run details')}
          aria-label={t('factoryView.details', 'Run details')}
          onClick={() => onSelect(run)}
          data-testid={`factory-view-details-${run.id}`}
        >
          <PanelRight className="icon-sm" />
        </TooltipIconButton>
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
  'needs_info',
  'requested',
  'queued',
  'triaging',
  'working',
  'pr_open',
  'waiting_ci',
  'fixing',
  'reviewing',
  'merging',
  'failed',
  'merged',
  'no_change',
  'done',
  'stopped',
];

/** The list under the toolbar: loading, empty, or one row per run. */
function FactoryQueueBody({
  runs,
  projectNameById,
  now,
  onSelect,
}: {
  runs: FactoryQueueRun[] | undefined;
  projectNameById: ReadonlyMap<string, string>;
  now: number;
  onSelect: (run: FactoryQueueRun) => void;
}) {
  const { t } = useTranslation();
  if (!runs) return <LoadingState testId="factory-view-loading" />;
  if (runs.length === 0) {
    return (
      <EmptyState
        icon={Factory}
        title={t('factoryView.empty', 'Nothing in the factory')}
        description={t(
          'factoryView.emptyDescription',
          'Issues sent to a project factory show here while they wait and run.',
        )}
        testId="factory-view-empty"
      />
    );
  }
  return (
    <ScrollArea className="min-h-0 flex-1">
      <ul className="flex flex-col gap-0.5 p-2" data-testid="factory-view-list">
        {runs.map((run) => (
          <FactoryRunRow
            key={run.id}
            run={run}
            projectName={projectNameById.get(run.projectId)}
            now={now}
            onSelect={onSelect}
          />
        ))}
      </ul>
    </ScrollArea>
  );
}

function FactoryQueueHeader({
  runs,
  projects,
}: {
  runs: FactoryQueueRun[] | undefined;
  projects: ReadonlyArray<{ id: string; name: string }>;
}) {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const all = runs ?? [];
  return (
    <div className="border-border flex flex-wrap items-center gap-x-6 gap-y-2 border-b px-4 py-3">
      <div className="min-w-0">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Factory className="icon-sm text-muted-foreground" />
          {t('factoryView.title', 'Factory queue')}
        </h2>
        <p className="text-muted-foreground text-sm">
          {t('factoryView.summary', '{{projects}} projects · {{runs}} runs', {
            projects: new Set(all.map((run) => run.projectId)).size,
            runs: all.length,
          })}
        </p>
      </div>
      {projects.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="outline"
              size="xs"
              className="ml-auto"
              onClick={() => setRunning(true)}
              data-testid="factory-view-run-flow"
            >
              <Play className="icon-sm" />
              {t('factory.runFlow.title', 'Run a flow')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t('factory.runFlowTooltip', 'Start one run of a flow in a project')}
          </TooltipContent>
        </Tooltip>
      )}
      {running && <RunFactoryFlowDialog open onOpenChange={setRunning} projects={projects} />}
    </div>
  );
}

/** The set with `value` added, or removed when it was in it. */
function toggled(selected: ReadonlySet<string>, value: string): Set<string> {
  const next = new Set(selected);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

function ClearFilters({ shown, onClear }: { shown: boolean; onClear: () => void }) {
  const { t } = useTranslation();
  if (!shown) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="muted-strong"
          size="xs"
          data-testid="factory-view-clear-filters"
          onClick={onClear}
        >
          {t('allThreads.clearFilters')}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {t('factoryView.clearFiltersTooltip', 'Remove the project and state filters')}
      </TooltipContent>
    </Tooltip>
  );
}

/** How many runs each state and project has, and the project options (only those with runs). */
function useFactoryQueueCounts(
  runs: FactoryQueueRun[] | undefined,
  projectNameById: ReadonlyMap<string, string>,
) {
  return useMemo(() => {
    const stateCounts: Record<string, number> = {};
    const projectCounts: Record<string, number> = {};
    for (const run of runs ?? []) {
      stateCounts[run.state] = (stateCounts[run.state] ?? 0) + 1;
      projectCounts[run.projectId] = (projectCounts[run.projectId] ?? 0) + 1;
    }
    const projectOptions = Object.keys(projectCounts)
      .map((id) => ({ value: id, label: projectNameById.get(id) ?? id }))
      .sort((a, b) => a.label.localeCompare(b.label));
    return { stateCounts, projectCounts, projectOptions };
  }, [runs, projectNameById]);
}

interface ToolbarProps {
  search: string;
  onSearchChange: (search: string) => void;
  caseSensitive: boolean;
  onCaseSensitiveChange: (caseSensitive: boolean) => void;
  stateFilter: Set<string>;
  onStateFilterChange: (states: Set<string>) => void;
  projectFilter: Set<string>;
  onProjectFilterChange: (projectIds: Set<string>) => void;
  onClearFilters: () => void;
  /** The projects that have runs, by name. */
  projectOptions: { value: string; label: string }[];
  projectCounts: Record<string, number>;
  /** How many runs the filters keep, of how many. */
  shown: number;
  total: number;
  stateCounts: Record<string, number>;
  activeOnly: boolean;
  onActiveOnlyChange: (activeOnly: boolean) => void;
  layout: FactoryViewLayout;
  onLayoutChange: (layout: FactoryViewLayout) => void;
  /** Every listed run, unfiltered: what the queue controls act on. */
  runs: readonly FactoryQueueRun[];
}

function FactoryQueueSearch({
  search,
  onSearchChange,
  caseSensitive,
  onCaseSensitiveChange,
  shown,
  total,
}: Pick<
  ToolbarProps,
  'search' | 'onSearchChange' | 'caseSensitive' | 'onCaseSensitiveChange' | 'shown' | 'total'
>) {
  const { t } = useTranslation();
  const searching = search.trim() !== '';
  return (
    <SearchBar
      query={search}
      onQueryChange={onSearchChange}
      totalMatches={shown}
      resultLabel={searching ? `${shown}/${total}` : ''}
      caseSensitive={caseSensitive}
      onCaseSensitiveChange={onCaseSensitiveChange}
      onClose={search ? () => onSearchChange('') : undefined}
      autoFocus={false}
      placeholder={t('factoryView.searchPlaceholder', 'Filter by issue, project or step')}
      testIdPrefix="factory-view-search"
      variant="outline"
      className="h-7 w-72 shrink-0"
    />
  );
}

function FactoryQueueFilters({
  stateFilter,
  onStateFilterChange,
  projectFilter,
  onProjectFilterChange,
  projectOptions,
  projectCounts,
  stateCounts,
}: Pick<
  ToolbarProps,
  | 'stateFilter'
  | 'onStateFilterChange'
  | 'projectFilter'
  | 'onProjectFilterChange'
  | 'projectOptions'
  | 'projectCounts'
  | 'stateCounts'
>) {
  const { t } = useTranslation();
  return (
    <>
      <FilterDropdown
        testId="factory-view-project-filter"
        label={t('allThreads.filterProject')}
        options={projectOptions}
        selected={projectFilter}
        onToggle={(projectId) => onProjectFilterChange(toggled(projectFilter, projectId))}
        counts={projectCounts}
      />
      <FilterDropdown
        testId="factory-view-status-filter"
        label={t('allThreads.filterStatus')}
        options={STATE_ORDER.map((state) => ({
          value: state,
          label: factoryRunStateLabel(t, state),
        }))}
        selected={stateFilter}
        onToggle={(state) => onStateFilterChange(toggled(stateFilter, state))}
        counts={stateCounts}
      />
    </>
  );
}

function FactoryQueueToolbar(props: ToolbarProps) {
  const { stateFilter, projectFilter } = props;
  return (
    <div className="border-border/50 flex items-center gap-2 border-b px-4 py-2">
      <FactoryQueueSearch {...props} />
      <div className="bg-border h-4 w-px" />
      <FactoryQueueFilters {...props} />
      <FactoryActiveToggle activeOnly={props.activeOnly} onChange={props.onActiveOnlyChange} />
      <ClearFilters
        shown={stateFilter.size > 0 || projectFilter.size > 0}
        onClear={props.onClearFilters}
      />
      <div className="ml-auto flex items-center gap-1">
        <FactoryQueueActions runs={props.runs} projectFilter={projectFilter} />
        {props.layout === 'board' && <FactoryBoardColumnsMenu />}
        <FactoryLayoutToggle layout={props.layout} onChange={props.onLayoutChange} />
      </div>
    </div>
  );
}

/** The view's filters (kept in the URL, so a filtered view can be linked) and the runs they keep. */
function useFactoryQueueFilters(
  runs: FactoryQueueRun[] | undefined,
  projectNameById: ReadonlyMap<string, string>,
) {
  const { filters, layout, update } = useFactoryViewParams();
  const { search, caseSensitive, states, projectIds, activeOnly } = filters;
  const filtered = useMemo(
    () =>
      runs &&
      filterFactoryRuns(runs, {
        search,
        caseSensitive,
        states,
        projectIds,
        projectNameById,
        activeOnly,
      }),
    [runs, search, caseSensitive, states, projectIds, projectNameById, activeOnly],
  );
  const toolbar = useMemo(
    () => ({
      search,
      onSearchChange: (value: string) => update({ search: value }),
      caseSensitive,
      onCaseSensitiveChange: (value: boolean) => update({ caseSensitive: value }),
      stateFilter: states,
      onStateFilterChange: (value: Set<string>) => update({ states: value }),
      projectFilter: projectIds,
      onProjectFilterChange: (value: Set<string>) => update({ projectIds: value }),
      onClearFilters: () => update({ states: new Set(), projectIds: new Set() }),
      activeOnly,
      onActiveOnlyChange: (value: boolean) => update({ activeOnly: value }),
      layout,
      onLayoutChange: (value: FactoryViewLayout) => update({ layout: value }),
    }),
    [search, caseSensitive, states, projectIds, activeOnly, layout, update],
  );
  return {
    filtered,
    toolbar,
    layout,
    singleProjectId: projectIds.size === 1 ? [...projectIds][0]! : null,
    shown: filtered?.length ?? 0,
  };
}

/** What the view shows under its toolbar: the board or the list, and the open run's panel. */
function FactoryQueueContent({
  runs,
  filtered,
  layout,
  projectNameById,
  now,
  singleProjectId,
}: {
  runs: FactoryQueueRun[] | undefined;
  filtered: FactoryQueueRun[] | undefined;
  layout: FactoryViewLayout;
  projectNameById: ReadonlyMap<string, string>;
  now: number;
  singleProjectId: string | null;
}) {
  const selection = useSelectedFactoryRun(runs);
  const dependencies = useMemo(() => factoryRunDependencies(runs ?? []), [runs]);
  const boardRuns = layout === 'board' && (runs?.length ?? 0) > 0 ? filtered : undefined;
  const selectedProject = selection.run ? projectNameById.get(selection.run.projectId) : undefined;
  const picked = useFactoryRunSelection(boardRuns);
  return (
    <>
      {layout === 'analytics' ? (
        <FactoryAnalytics runs={runs} filtered={filtered} now={now} />
      ) : boardRuns ? (
        <div className="relative flex min-h-0 flex-1 flex-col">
          <FactoryBoard
            runs={boardRuns}
            projectNameById={projectNameById}
            now={now}
            singleProjectId={singleProjectId}
            onSelect={selection.select}
            dependencies={dependencies}
            selectedIds={picked.selectedIds}
            onToggleSelected={picked.toggle}
          />
          <FactoryBulkActions runs={picked.selectedRuns} onClear={picked.clear} />
        </div>
      ) : (
        <FactoryQueueBody
          runs={filtered}
          projectNameById={projectNameById}
          now={now}
          onSelect={selection.select}
        />
      )}
      <FactoryRunDetail
        run={selection.run}
        projectName={selectedProject}
        onClose={selection.close}
        dependencies={dependencies}
        onSelect={selection.select}
      />
    </>
  );
}

export function FactoryQueueView() {
  const runs = useFactoryQueueRuns();
  const projects = useProjects();
  const now = useMinuteTick();

  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );
  const counts = useFactoryQueueCounts(runs, projectNameById);
  const { filtered, toolbar, layout, singleProjectId, shown } = useFactoryQueueFilters(
    runs,
    projectNameById,
  );
  const all = runs ?? [];

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col" data-testid="factory-view">
      <FactoryQueueHeader runs={runs} projects={projects} />
      <FactoryIncidentBanners runs={all} />
      <FactoryQueueToolbar {...toolbar} {...counts} runs={all} shown={shown} total={all.length} />
      <FactoryQueueContent
        runs={runs}
        filtered={filtered}
        layout={layout}
        projectNameById={projectNameById}
        now={now}
        singleProjectId={singleProjectId}
      />
    </div>
  );
}
