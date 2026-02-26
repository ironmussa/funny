import {
  ChevronLeft,
  Plus,
  CheckCircle2,
  Eye,
  LayoutList,
  ClipboardList,
  DollarSign,
  Archive,
} from 'lucide-react';
import { useEffect, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { useAppStore } from '@/stores/app-store';

import { GroupBySelector, type GroupBy } from './analytics/GroupBySelector';
import { MetricCard } from './analytics/MetricCard';
import { StageDistributionChart } from './analytics/StageDistributionChart';
import { TimelineChart } from './analytics/TimelineChart';
import { TimeRangeSelector, type TimeRange } from './analytics/TimeRangeSelector';

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
  const navigate = useNavigate();
  const projects = useAppStore((s) => s.projects);
  const selectedProjectId = useAppStore((s) => s.selectedProjectId);

  const [projectId, setProjectId] = useState<string>(() => selectedProjectId || '__all__');
  const [timeRange, setTimeRange] = useState<TimeRange>('month');
  const [groupBy, setGroupBy] = useState<GroupBy>('day');
  const [overview, setOverview] = useState<OverviewData | null>(null);
  const [timeline, setTimeline] = useState<TimelineData | null>(null);
  const [loading, setLoading] = useState(false);

  const _selectedProject = useMemo(
    () => projects.find((p) => p.id === projectId),
    [projects, projectId],
  );

  useEffect(() => {
    setLoading(true);
    const params = new URLSearchParams({ timeRange });
    if (projectId !== '__all__') params.set('projectId', projectId);

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
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={() => navigate('/')}
          className="text-muted-foreground hover:text-foreground"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-medium">{t('analytics.title')}</h2>
        </div>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 border-b border-border/50 px-4 py-2">
        <Select value={projectId} onValueChange={setProjectId}>
          <SelectTrigger className="h-7 w-[180px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">{t('analytics.allProjects')}</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="h-4 w-px bg-border" />

        <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
      </div>

      {/* Content */}
      <ScrollArea className="min-h-0 flex-1">
        <div className="mx-auto max-w-4xl space-y-6 px-6 py-6">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-primary" />
              <span className="ml-3 text-sm text-muted-foreground">{t('analytics.loading')}</span>
            </div>
          ) : !overview ? (
            <div className="py-16 text-center text-sm text-muted-foreground">
              {t('analytics.noData')}
            </div>
          ) : (
            <>
              {/* Metric Cards */}
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                <MetricCard
                  title={t('analytics.tasksCreated')}
                  value={overview.createdCount}
                  icon={<Plus className="h-3.5 w-3.5" />}
                  color="blue"
                />
                <MetricCard
                  title={t('analytics.tasksCompleted')}
                  value={overview.completedCount}
                  icon={<CheckCircle2 className="h-3.5 w-3.5" />}
                  color="green"
                />
                <MetricCard
                  title={t('analytics.movedToPlanning')}
                  value={overview.movedToPlanningCount}
                  icon={<ClipboardList className="h-3.5 w-3.5" />}
                  color="violet"
                />
                <MetricCard
                  title={t('analytics.movedToReview')}
                  value={overview.movedToReviewCount}
                  icon={<Eye className="h-3.5 w-3.5" />}
                  color="amber"
                />
                <MetricCard
                  title={t('analytics.movedToDone')}
                  value={overview.movedToDoneCount}
                  icon={<LayoutList className="h-3.5 w-3.5" />}
                  color="violet"
                />
                <MetricCard
                  title={t('analytics.movedToArchived')}
                  value={overview.movedToArchivedCount}
                  icon={<Archive className="h-3.5 w-3.5" />}
                  color="red"
                />
              </div>

              {/* Cost card */}
              {overview.totalCost > 0 && (
                <div className="flex items-center justify-between rounded-lg border border-border p-4">
                  <div>
                    <p className="text-xs text-muted-foreground">{t('analytics.totalCost')}</p>
                    <p className="mt-1 text-xl font-bold">${overview.totalCost.toFixed(4)}</p>
                  </div>
                  <div className="rounded-md bg-status-success/10 p-2 text-status-success/80">
                    <DollarSign className="h-4 w-4" />
                  </div>
                </div>
              )}

              {/* Stage Distribution */}
              <div className="rounded-lg border border-border p-5">
                <h3 className="mb-4 text-sm font-semibold">{t('analytics.currentDistribution')}</h3>
                <StageDistributionChart data={overview.currentStageDistribution} />
              </div>

              {/* Timeline */}
              {timeline && (
                <div className="rounded-lg border border-border p-5">
                  <div className="mb-4 flex items-center justify-between">
                    <h3 className="text-sm font-semibold">{t('analytics.timeline')}</h3>
                    <GroupBySelector value={groupBy} onChange={setGroupBy} />
                  </div>
                  <TimelineChart
                    created={timeline.createdByDate}
                    completed={timeline.completedByDate}
                    movedToPlanning={timeline.movedToPlanningByDate ?? []}
                    movedToReview={timeline.movedToReviewByDate}
                    movedToDone={timeline.movedToDoneByDate}
                    movedToArchived={timeline.movedToArchivedByDate ?? []}
                    groupBy={groupBy}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
