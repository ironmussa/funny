import {
  BarChart3,
  Plus,
  CheckCircle2,
  Eye,
  LayoutList,
  ClipboardList,
  DollarSign,
  Archive,
  Loader2,
  ChevronDown,
  Check,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api } from '@/lib/api';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';

import { MetricCard } from './analytics/MetricCard';
import { TimeRangeSelector, type TimeRange } from './analytics/TimeRangeSelector';

// Lazy-loaded: recharts is ~85KB, only pulled in when the user opens this view
const StageDistributionChart = lazy(() =>
  import('./analytics/StageDistributionChart').then((m) => ({ default: m.StageDistributionChart })),
);
const TimelineChart = lazy(() =>
  import('./analytics/TimelineChart').then((m) => ({ default: m.TimelineChart })),
);

const ChartFallback = () => (
  <div className="flex h-64 items-center justify-center text-xs text-muted-foreground">
    Loading…
  </div>
);

interface OverviewData {
  currentStageDistribution: Record<string, number>;
  createdCount: number;
  completedCount: number;
  movedToPlanningCount: number;
  movedToReviewCount: number;
  movedToDoneCount: number;
  movedToArchivedCount: number;
  totalCost: number;
  timeRange: { start: string; end: string };
}

interface TimelineData {
  createdByDate: Array<{ date: string; count: number }>;
  completedByDate: Array<{ date: string; count: number }>;
  movedToPlanningByDate: Array<{ date: string; count: number }>;
  movedToReviewByDate: Array<{ date: string; count: number }>;
  movedToDoneByDate: Array<{ date: string; count: number }>;
  movedToArchivedByDate: Array<{ date: string; count: number }>;
  timeRange: { start: string; end: string };
}

export function AnalyticsView() {
  const { t } = useTranslation();
  const projects = useAppStore((s) => s.projects);
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);

  const [projectId, setProjectId] = useState<string>(() => selectedProjectId || '__all__');
  const [timeRange, setTimeRange] = useState<TimeRange>('month');
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(false);

  const selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId),
    [projects, projectId],
  );

  // Auto-derive groupBy from timeRange so we don't need a separate selector
  const groupBy =
    timeRange === 'day'
      ? 'day'
      : timeRange === 'week'
        ? 'day'
        : timeRange === 'month'
          ? 'week'
          : 'month';

  useEffect(() => {
    setLoading(true);

    Promise.all([
      api.analyticsOverview(projectId === '__all__' ? undefined : projectId, timeRange),
      api.analyticsTimeline(projectId === '__all__' ? undefined : projectId, timeRange, groupBy),
    ])
      .then(([overviewRes, timelineRes]) => {
        if (overviewRes.isOk()) setOverview(overviewRes.value);
        if (timelineRes.isOk()) setTimeline(timelineRes.value);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [projectId, timeRange, groupBy]);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <BarChart3 className="icon-sm text-muted-foreground" /> {t('analytics.title')}
          </h2>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 border-b border-border/50 px-4 py-2">
        <Popover>
          <PopoverTrigger asChild>
            <button
              data-testid="analytics-project-filter"
              className={cn(
                'inline-flex items-center gap-1 px-2 py-1 text-xs rounded-md border transition-colors whitespace-nowrap',
                projectId !== '__all__'
                  ? 'bg-accent text-accent-foreground border-accent-foreground/20'
                  : 'bg-transparent text-muted-foreground border-border hover:bg-accent/50 hover:text-foreground',
              )}
            >
              {projectId !== '__all__' && selectedProject
                ? selectedProject.name
                : t('analytics.allProjects')}
              <ChevronDown className="icon-xs opacity-50" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-auto min-w-[180px] p-0">
            <ScrollArea className="max-h-[300px] p-1">
              <button
                onClick={() => setProjectId('__all__')}
                className={cn(
                  'flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm transition-colors text-left',
                  'hover:bg-accent hover:text-accent-foreground',
                  projectId === '__all__' && 'text-accent-foreground',
                )}
              >
                <span
                  className={cn(
                    'flex h-3.5 w-3.5 items-center justify-center rounded-full border',
                    projectId === '__all__'
                      ? 'bg-primary border-primary text-primary-foreground'
                      : 'border-muted-foreground/30',
                  )}
                >
                  {projectId === '__all__' && <Check className="icon-2xs" />}
                </span>
                <span className="flex-1">{t('analytics.allProjects')}</span>
              </button>
              {projects.map((p) => {
                const isActive = projectId === p.id;
                return (
                  <button
                    key={p.id}
                    onClick={() => setProjectId(p.id)}
                    className={cn(
                      'flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded-sm transition-colors text-left',
                      'hover:bg-accent hover:text-accent-foreground',
                      isActive && 'text-accent-foreground',
                    )}
                  >
                    <span
                      className={cn(
                        'flex h-3.5 w-3.5 items-center justify-center rounded-full border',
                        isActive
                          ? 'bg-primary border-primary text-primary-foreground'
                          : 'border-muted-foreground/30',
                      )}
                    >
                      {isActive && <Check className="icon-2xs" />}
                    </span>
                    <span className="flex-1 truncate">{p.name}</span>
                  </button>
                );
              })}
            </ScrollArea>
          </PopoverContent>
        </Popover>

        <div className="h-4 w-px bg-border" />

        <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
      </div>

      {/* Content */}
      {loading ? (
        <div
          className="flex flex-1 items-center justify-center text-muted-foreground"
          data-testid="analytics-loading"
        >
          <Loader2 className="icon-lg animate-spin" />
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
            {!overview ? (
              <div
                className="py-16 text-center text-sm text-muted-foreground"
                data-testid="analytics-no-data"
              >
                {t('analytics.noData')}
              </div>
            ) : (
              <>
                {/* Metric Cards */}
                <div
                  className="grid grid-cols-2 gap-3 lg:grid-cols-3"
                  data-testid="analytics-metric-cards"
                >
                  <MetricCard
                    title={t('analytics.tasksCreated')}
                    value={overview.createdCount}
                    icon={<Plus className="icon-sm" />}
                    color="blue"
                  />
                  <MetricCard
                    title={t('analytics.tasksCompleted')}
                    value={overview.completedCount}
                    icon={<CheckCircle2 className="icon-sm" />}
                    color="green"
                  />
                  <MetricCard
                    title={t('analytics.movedToPlanning')}
                    value={overview.movedToPlanningCount}
                    icon={<ClipboardList className="icon-sm" />}
                    color="violet"
                  />
                  <MetricCard
                    title={t('analytics.movedToReview')}
                    value={overview.movedToReviewCount}
                    icon={<Eye className="icon-sm" />}
                    color="amber"
                  />
                  <MetricCard
                    title={t('analytics.movedToDone')}
                    value={overview.movedToDoneCount}
                    icon={<LayoutList className="icon-sm" />}
                    color="violet"
                  />
                  <MetricCard
                    title={t('analytics.movedToArchived')}
                    value={overview.movedToArchivedCount}
                    icon={<Archive className="icon-sm" />}
                    color="red"
                  />
                </div>

                {/* Cost card */}
                {overview.totalCost > 0 && (
                  <div
                    className="flex items-center justify-between rounded-lg border border-border p-4"
                    data-testid="analytics-cost-card"
                  >
                    <div>
                      <p className="text-xs text-muted-foreground">{t('analytics.totalCost')}</p>
                      <p className="mt-1 text-xl font-bold">${overview.totalCost.toFixed(4)}</p>
                    </div>
                    <div className="rounded-md bg-status-success/10 p-2 text-status-success/80">
                      <DollarSign className="icon-base" />
                    </div>
                  </div>
                )}

                {/* Stage Distribution */}
                <div
                  className="rounded-lg border border-border p-5"
                  data-testid="analytics-stage-chart"
                >
                  <h3 className="mb-4 text-sm font-semibold">
                    {t('analytics.currentDistribution')}
                  </h3>
                  <Suspense fallback={<ChartFallback />}>
                    <StageDistributionChart data={overview.currentStageDistribution} />
                  </Suspense>
                </div>

                {/* Timeline */}
                {timeline && (
                  <div
                    className="rounded-lg border border-border p-5"
                    data-testid="analytics-timeline-chart"
                  >
                    <h3 className="mb-4 text-sm font-semibold">{t('analytics.timeline')}</h3>
                    <Suspense fallback={<ChartFallback />}>
                      <TimelineChart
                        created={timeline.createdByDate}
                        completed={timeline.completedByDate}
                        movedToPlanning={timeline.movedToPlanningByDate ?? []}
                        movedToReview={timeline.movedToReviewByDate}
                        movedToDone={timeline.movedToDoneByDate}
                        movedToArchived={timeline.movedToArchivedByDate ?? []}
                        groupBy={groupBy}
                      />
                    </Suspense>
                  </div>
                )}
              </>
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
