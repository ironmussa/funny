/**
 * A factory run's actions: open its pull request, and the member's controls
 * (retry a failed or parked run, stop one that has not ended). Shared by the
 * project's run list, the footer indicator's popover and the failure card in
 * the thread. Renders the buttons only; the caller lays them out.
 */
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { controlFactoryRun } from '@/data/factory/actions';
import { useCanSteerProject } from '@/data/projects/hooks';
import type { FactoryRun } from '@/lib/api/factory';
import { ENDED_FACTORY_STATES } from '@/lib/factory-run-labels';
import { toastError } from '@/lib/toast-error';

/** A run parked on its issue (`needs_info`) is triaged again by a retry. */
const RETRYABLE = new Set<FactoryRun['state']>([
  'failed',
  'waiting_human',
  'no_change',
  'needs_info',
]);

export function FactoryRunControls({
  projectId,
  run,
  testId,
  children,
}: {
  projectId: string;
  run: FactoryRun;
  /** The buttons' test ids, so several copies on one page stay apart. */
  testId: (button: 'pr' | 'retry' | 'stop') => string;
  /** More links, between the pull request and the controls. */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const canSteer = useCanSteerProject(projectId);
  const control = (action: 'stop' | 'retry') =>
    void controlFactoryRun(action, projectId, run.id).orTee((error) =>
      toastError(error, 'factory'),
    );

  return (
    <>
      {run.prUrl && (
        <Button asChild size="xs" variant="link" data-testid={testId('pr')}>
          <a href={run.prUrl} target="_blank" rel="noreferrer">
            {t('factory.pullRequest', 'PR')}
          </a>
        </Button>
      )}
      {children}
      {canSteer && RETRYABLE.has(run.state) && (
        <Button
          size="xs"
          variant="outline"
          data-testid={testId('retry')}
          onClick={() => control('retry')}
        >
          {t('factory.retry', 'Retry')}
        </Button>
      )}
      {canSteer && !ENDED_FACTORY_STATES.has(run.state) && (
        <Button
          size="xs"
          variant="ghost"
          data-testid={testId('stop')}
          onClick={() => control('stop')}
        >
          {t('factory.stop', 'Stop')}
        </Button>
      )}
    </>
  );
}
