/**
 * The factory view's queue controls (change factory-manual-queue): "Clear
 * queue" removes the issues waiting in the queue, "Stop all" also stops the
 * runs in progress and their agent threads. Both ask for a confirmation first.
 * They act on the projects the project filter keeps (every project with runs
 * when it keeps all), one request per project that has something to clear or
 * stop.
 */
import { ListX, Square } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { emptyFactory } from '@/data/factory/actions';
import type { FactoryQueueRun } from '@/lib/api/factory';
import { ENDED_FACTORY_STATES } from '@/lib/factory-run-labels';
import { toastError } from '@/lib/toast-error';

type EmptyAction = 'clear-queue' | 'stop-all';

/** The projects, among `runs`, that have something for `action` to clear or stop. */
export function projectsToEmpty(
  runs: readonly FactoryQueueRun[],
  scope: ReadonlySet<string>,
  action: EmptyAction,
): string[] {
  const affected = (run: FactoryQueueRun) =>
    action === 'clear-queue'
      ? run.state === 'requested'
      : !ENDED_FACTORY_STATES.has(run.state) && run.state !== 'waiting_human';
  const projects = runs.flatMap((run) =>
    (scope.size === 0 || scope.has(run.projectId)) && affected(run) ? [run.projectId] : [],
  );
  return [...new Set(projects)];
}

/** How many issues wait in the queue of the projects `scope` keeps. */
function queuedIssues(runs: readonly FactoryQueueRun[], scope: ReadonlySet<string>): number {
  return runs.filter(
    (run) => run.state === 'requested' && (scope.size === 0 || scope.has(run.projectId)),
  ).length;
}

export function FactoryQueueActions({
  runs,
  projectFilter,
}: {
  runs: readonly FactoryQueueRun[];
  projectFilter: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState<EmptyAction | null>(null);
  const toClear = projectsToEmpty(runs, projectFilter, 'clear-queue');
  const toStop = projectsToEmpty(runs, projectFilter, 'stop-all');
  const empty = (action: EmptyAction, projectIds: string[]) => {
    for (const projectId of projectIds) {
      void emptyFactory(action, projectId).orTee((error) => toastError(error, 'factory'));
    }
  };
  const stopDescription =
    toStop.length > 1
      ? t(
          'factory.stopAllProjectsDesc',
          'This clears the queue and stops every run in progress and its agent threads, in {{count}} projects.',
          { count: toStop.length },
        )
      : t(
          'factory.stopAllDesc',
          'This clears the queue and stops every run in progress and its agent threads.',
        );
  const clearDescription = t(
    'factory.clearQueueDesc',
    'This removes every issue waiting in the queue ({{count}}). Runs in progress keep going.',
    { count: queuedIssues(runs, projectFilter) },
  );

  return (
    <>
      {toClear.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="xs"
              variant="outline"
              data-testid="factory-clear-queue"
              onClick={() => setConfirming('clear-queue')}
            >
              <ListX className="icon-sm" />
              {t('factory.clearQueue', 'Clear queue')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t('factory.clearQueueTooltip', 'Remove the issues waiting in the queue')}
          </TooltipContent>
        </Tooltip>
      )}
      {toStop.length > 0 && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              size="xs"
              variant="outline-destructive"
              data-testid="factory-stop-all"
              onClick={() => setConfirming('stop-all')}
            >
              <Square className="icon-sm" />
              {t('factory.stopAll', 'Stop all')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>
            {t('factory.stopAllTooltip', 'Clear the queue and stop every run in progress')}
          </TooltipContent>
        </Tooltip>
      )}
      <ConfirmDialog
        open={confirming !== null}
        onOpenChange={(open) => !open && setConfirming(null)}
        title={
          confirming === 'clear-queue'
            ? t('factory.clearQueueTitle', 'Clear the queue?')
            : t('factory.stopAllTitle', 'Stop the factory?')
        }
        description={confirming === 'clear-queue' ? clearDescription : stopDescription}
        confirmLabel={
          confirming === 'clear-queue'
            ? t('factory.clearQueue', 'Clear queue')
            : t('factory.stopAll', 'Stop all')
        }
        cancelLabel={t('common.cancel', 'Cancel')}
        onCancel={() => setConfirming(null)}
        onConfirm={() => {
          const action = confirming;
          setConfirming(null);
          if (action) empty(action, action === 'clear-queue' ? toClear : toStop);
        }}
      />
    </>
  );
}
