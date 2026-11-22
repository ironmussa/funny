/**
 * The factory view (`/factory`): every run of the caller's issue factories,
 * across projects, that has not ended or failed recently — grouped as waiting
 * for the member, in progress, in the queue and failed. Laid out like the
 * global search view; a row opens the run's last agent thread, and carries the
 * run's controls (PR, retry, stop).
 */
import { Factory } from 'lucide-react';
import { memo, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { FactoryRunControls } from '@/components/thread/FactoryRunControls';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { LoadingState } from '@/components/ui/loading-state';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useFactoryQueueRuns } from '@/data/factory/hooks';
import { useProjects } from '@/data/projects/hooks';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { useStableNavigate } from '@/hooks/use-stable-navigate';
import type { FactoryQueueRun } from '@/lib/api/factory';
import {
  FACTORY_QUEUE_SECTIONS,
  factoryRunStateLabel,
  factoryRunStateVariant,
  factoryWaitReasonText,
  groupFactoryRuns,
  type FactoryQueueSection,
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
      className="hover:bg-accent/50 flex items-center gap-3 rounded-md px-3 py-2"
      data-testid={`factory-view-run-${run.id}`}
    >
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
        <span className="w-full truncate text-sm">{title}</span>
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

export function FactoryQueueView() {
  const { t } = useTranslation();
  const runs = useFactoryQueueRuns();
  const projects = useProjects();
  const now = useMinuteTick();
  const [search, setSearch] = useState('');

  const projectNameById = useMemo(
    () => new Map(projects.map((project) => [project.id, project.name])),
    [projects],
  );

  const filtered = useMemo(() => {
    if (!runs) return undefined;
    const needle = search.trim().toLowerCase().replace(/^#/, '');
    if (!needle) return runs;
    return runs.filter(
      (run) =>
        String(run.issueNumber).includes(needle) ||
        (projectNameById.get(run.projectId) ?? '').toLowerCase().includes(needle) ||
        (run.currentStep ?? '').toLowerCase().includes(needle),
    );
  }, [runs, search, projectNameById]);

  const groups = useMemo(() => (filtered ? groupFactoryRuns(filtered) : undefined), [filtered]);

  const sectionTitle: Record<FactoryQueueSection, string> = {
    waiting: t('factoryView.waiting', 'Waiting for you'),
    active: t('factoryView.active', 'In progress'),
    queue: t('factoryView.queue', 'In queue'),
    failed: t('factoryView.failed', 'Failed recently'),
  };

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

      <div className="border-border border-b px-4 py-2">
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t('factoryView.searchPlaceholder', 'Filter by issue, project or step')}
          className="h-7 max-w-sm text-sm"
          data-testid="factory-view-search"
        />
      </div>

      {!groups ? (
        <LoadingState testId="factory-view-loading" />
      ) : filtered?.length === 0 ? (
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
          <div className="flex flex-col gap-4 p-3">
            {FACTORY_QUEUE_SECTIONS.filter((id) => groups[id].length > 0).map((id) => (
              <section key={id} data-testid={`factory-view-section-${id}`}>
                <h3 className="text-muted-foreground mb-1 flex items-center gap-2 px-3 text-xs font-medium uppercase">
                  {sectionTitle[id]}
                  <span>{groups[id].length}</span>
                </h3>
                <ul>
                  {groups[id].map((run) => (
                    <FactoryRunRow
                      key={run.id}
                      run={run}
                      projectName={projectNameById.get(run.projectId)}
                      now={now}
                    />
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
