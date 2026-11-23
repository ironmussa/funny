/**
 * The factory view's queue controls (change factory-manual-queue): "Clear
 * queue" removes the issues waiting in the queue, "Stop all" also stops the
 * runs in progress and their agent threads, after a confirmation. They act on
 * the projects the project filter keeps (every project with runs when it keeps
 * all), one request per project that has something to clear or stop.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { Button } from '@/components/ui/button';
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

export function FactoryQueueActions({
  runs,
  projectFilter,
}: {
  runs: readonly FactoryQueueRun[];
  projectFilter: ReadonlySet<string>;
}) {
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const toClear = projectsToEmpty(runs, projectFilter, 'clear-queue');
  const toStop = projectsToEmpty(runs, projectFilter, 'stop-all');
  const empty = (action: EmptyAction, projectIds: string[]) => {
    for (const projectId of projectIds) {
      void emptyFactory(action, projectId).orTee((error) => toastError(error, 'factory'));
    }
  };

  return (
    <>
      {toClear.length > 0 && (
        <Button
          size="xs"
          variant="ghost"
          data-testid="factory-clear-queue"
          onClick={() => empty('clear-queue', toClear)}
        >
          {t('factory.clearQueue', 'Clear queue')}
        </Button>
      )}
      {toStop.length > 0 && (
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
        description={
          toStop.length > 1
            ? t(
                'factory.stopAllProjectsDesc',
                'This clears the queue and stops every run in progress and its agent threads, in {{count}} projects.',
                { count: toStop.length },
              )
            : t(
                'factory.stopAllDesc',
                'This clears the queue and stops every run in progress and its agent threads.',
              )
        }
        confirmLabel={t('factory.stopAll', 'Stop all')}
        cancelLabel={t('common.cancel', 'Cancel')}
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          empty('stop-all', toStop);
        }}
      />
    </>
  );
}
