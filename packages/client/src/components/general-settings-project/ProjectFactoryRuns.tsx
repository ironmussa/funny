/**
 * The runs of the caller's issue factory for a project (issue-factory phase 4):
 * each issue's state and current step, its pull request and agent threads, and
 * the member's controls — stop a run in flight, retry one that failed or waits
 * for them. A run waiting for the member is called out; following up on its
 * last thread (the thread link) takes it over.
 */
import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { controlFactoryRun } from '@/data/factory/actions';
import { useFactoryRuns } from '@/data/factory/hooks';
import type { FactoryRun } from '@/lib/api/factory';
import { getThreadRoute } from '@/lib/thread-variant';
import { toastError } from '@/lib/toast-error';

const ENDED = new Set<FactoryRun['state']>(['merged', 'failed', 'stopped']);
const RETRYABLE = new Set<FactoryRun['state']>(['failed', 'waiting_human']);

function stateLabel(t: TFunction, state: FactoryRun['state']): string {
  const labels: Record<FactoryRun['state'], string> = {
    queued: t('factory.state.queued', 'Queued'),
    working: t('factory.state.working', 'Working'),
    pr_open: t('factory.state.prOpen', 'PR open'),
    waiting_ci: t('factory.state.waitingCi', 'Waiting for CI'),
    fixing: t('factory.state.fixing', 'Fixing CI'),
    waiting_human: t('factory.state.waitingHuman', 'Waiting for you'),
    merged: t('factory.state.merged', 'Merged'),
    failed: t('factory.state.failed', 'Failed'),
    stopped: t('factory.state.stopped', 'Stopped'),
  };
  return labels[state];
}

function stateVariant(state: FactoryRun['state']) {
  if (state === 'waiting_human') return 'default' as const;
  if (state === 'failed') return 'destructive' as const;
  return ENDED.has(state) ? ('outline' as const) : ('secondary' as const);
}

function RunRow({ projectId, run }: { projectId: string; run: FactoryRun }) {
  const { t } = useTranslation();
  const lastThread = run.threadIds.at(-1);
  const control = (action: 'stop' | 'retry') =>
    void controlFactoryRun(action, projectId, run.id).orTee((error) => toastError(error));

  return (
    <li className="flex items-center gap-2 py-1.5 text-sm" data-testid={`factory-run-${run.id}`}>
      <span className="w-14 shrink-0 font-medium">#{run.issueNumber}</span>
      <Badge size="xs" variant={stateVariant(run.state)}>
        {stateLabel(t, run.state)}
      </Badge>
      {run.currentStep && <span className="text-muted-foreground truncate">{run.currentStep}</span>}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        {run.prUrl && (
          <Button asChild size="xs" variant="link" data-testid={`factory-run-pr-${run.id}`}>
            <a href={run.prUrl} target="_blank" rel="noreferrer">
              {t('factory.pullRequest', 'PR')}
            </a>
          </Button>
        )}
        {lastThread && (
          <Button asChild size="xs" variant="link" data-testid={`factory-run-thread-${run.id}`}>
            <Link to={getThreadRoute({ id: lastThread, projectId, isScratch: false })}>
              {t('factory.thread', 'Thread')}
            </Link>
          </Button>
        )}
        {RETRYABLE.has(run.state) && (
          <Button
            size="xs"
            variant="outline"
            data-testid={`factory-run-retry-${run.id}`}
            onClick={() => control('retry')}
          >
            {t('factory.retry', 'Retry')}
          </Button>
        )}
        {!ENDED.has(run.state) && (
          <Button
            size="xs"
            variant="ghost"
            data-testid={`factory-run-stop-${run.id}`}
            onClick={() => control('stop')}
          >
            {t('factory.stop', 'Stop')}
          </Button>
        )}
      </span>
    </li>
  );
}

export function ProjectFactoryRuns({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const runs = useFactoryRuns(projectId);
  if (!runs?.length) return null;
  const waiting = runs.filter((run) => run.state === 'waiting_human').length;

  return (
    <div className="px-4 py-3" data-testid="factory-runs">
      <div className="mb-1 flex items-center gap-2 text-sm font-medium">
        {t('factory.runs', 'Factory runs')}
        {waiting > 0 && (
          <Badge size="xs" data-testid="factory-runs-waiting">
            {t('factory.waitingCount', '{{count}} waiting for you', { count: waiting })}
          </Badge>
        )}
      </div>
      <ul className="divide-border divide-y">
        {runs.map((run) => (
          <RunRow key={run.id} projectId={projectId} run={run} />
        ))}
      </ul>
    </div>
  );
}
