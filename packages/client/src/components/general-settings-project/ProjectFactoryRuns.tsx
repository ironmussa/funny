/**
 * The runs of the caller's issue factory for a project (issue-factory phase 4):
 * each issue's state and current step, its pull request and agent threads, and
 * the member's controls — stop a run in flight, retry one that failed or waits
 * for them. A run waiting for the member is called out; following up on its
 * last thread (the thread link) takes it over. Issues sent to the factory wait
 * in its queue (change factory-manual-queue), with why they wait; "Clear queue"
 * removes them and "Stop all" also stops the runs in progress, after a
 * confirmation.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { FactoryRunControls } from '@/components/thread/FactoryRunControls';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { emptyFactory } from '@/data/factory/actions';
import { useFactoryRuns } from '@/data/factory/hooks';
import type { FactoryRun } from '@/lib/api/factory';
import {
  ENDED_FACTORY_STATES as ENDED,
  factoryRunStateLabel as stateLabel,
  factoryRunStateVariant as stateVariant,
  factoryWaitReasonText,
} from '@/lib/factory-run-labels';
import { getThreadRoute } from '@/lib/thread-variant';
import { toastError } from '@/lib/toast-error';

function RunRow({ projectId, run }: { projectId: string; run: FactoryRun }) {
  const { t } = useTranslation();
  const lastThread = run.threadIds.at(-1);
  return (
    <li className="flex items-center gap-2 py-1.5 text-sm" data-testid={`factory-run-${run.id}`}>
      <span className="w-14 shrink-0 font-medium">#{run.issueNumber}</span>
      <Badge size="xs" variant={stateVariant(run.state)}>
        {stateLabel(t, run.state)}
      </Badge>
      {run.currentStep && <span className="text-muted-foreground truncate">{run.currentStep}</span>}
      {run.state === 'requested' && run.waitReason && (
        <span className="text-muted-foreground truncate" data-testid={`factory-run-wait-${run.id}`}>
          {factoryWaitReasonText(t, run.waitReason)}
        </span>
      )}
      <span className="ml-auto flex shrink-0 items-center gap-1">
        <FactoryRunControls
          projectId={projectId}
          run={run}
          testId={(button) => `factory-run-${button}-${run.id}`}
        >
          {lastThread && (
            <Button asChild size="xs" variant="link" data-testid={`factory-run-thread-${run.id}`}>
              <Link to={getThreadRoute({ id: lastThread, projectId, isScratch: false })}>
                {t('factory.thread', 'Thread')}
              </Link>
            </Button>
          )}
        </FactoryRunControls>
      </span>
    </li>
  );
}

/** The queue first (in its order), then the other runs newest first. */
function ordered(runs: FactoryRun[]): FactoryRun[] {
  const queue = runs
    .filter((run) => run.state === 'requested')
    .sort((a, b) => (a.queueOrder ?? 0) - (b.queueOrder ?? 0));
  return [...queue, ...runs.filter((run) => run.state !== 'requested')];
}

function QueueControls({ projectId, runs }: { projectId: string; runs: FactoryRun[] }) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const queued = runs.some((run) => run.state === 'requested');
  const active = runs.some((run) => !ENDED.has(run.state) && run.state !== 'waiting_human');
  const empty = (action: 'clear-queue' | 'stop-all') =>
    void emptyFactory(action, projectId).orTee((error) => toastError(error, 'factory'));

  return (
    <span className="ml-auto flex items-center gap-1">
      {queued && (
        <Button
          size="xs"
          variant="ghost"
          data-testid="factory-clear-queue"
          onClick={() => empty('clear-queue')}
        >
          {t('factory.clearQueue', 'Clear queue')}
        </Button>
      )}
      {active && (
        <Button
          size="xs"
          variant="ghost"
          className="text-destructive"
          data-testid="factory-stop-all"
          onClick={() => setConfirming(true)}
        >
          {t('factory.stopAll', 'Stop all')}
        </Button>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={t('factory.stopAllTitle', 'Stop the factory?')}
        description={t(
          'factory.stopAllDesc',
          'This clears the queue and stops every run in progress and its agent threads.',
        )}
        confirmLabel={t('factory.stopAll', 'Stop all')}
        cancelLabel={t('common.cancel', 'Cancel')}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          empty('stop-all');
        }}
      />
    </span>
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
        <QueueControls projectId={projectId} runs={runs} />
      </div>
      <ul className="divide-border divide-y">
        {ordered(runs).map((run) => (
          <RunRow key={run.id} projectId={projectId} run={run} />
        ))}
      </ul>
    </div>
  );
}
