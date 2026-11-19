/**
 * The issue factory run a factory thread belongs to (issue #343), above the
 * conversation: the flow's step chain with how far the run got, its state, its
 * pull request, why it failed, and the member's controls (retry a failed or
 * parked run, stop one in flight). Without it a thread could keep working
 * after its run had already failed, with nothing in the thread saying so.
 */
import { Check, ChevronRight, Circle, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { controlFactoryRun } from '@/data/factory/actions';
import { useFactoryRunForThread } from '@/data/factory/hooks';
import { useCanSteerProject } from '@/data/projects/hooks';
import type { FactoryRun } from '@/lib/api/factory';
import {
  ENDED_FACTORY_STATES,
  factoryRunStateLabel,
  factoryRunStateVariant,
  factoryRunSteps,
  type FactoryStepStatus,
} from '@/lib/factory-run-labels';
import { toastError } from '@/lib/toast-error';
import { cn } from '@/lib/utils';

const RETRYABLE = new Set<FactoryRun['state']>(['failed', 'waiting_human']);

const STEP_ICON: Record<FactoryStepStatus, typeof Check> = {
  done: Check,
  current: Loader2,
  failed: X,
  pending: Circle,
};

function StepChain({ run }: { run: FactoryRun }) {
  const steps = factoryRunSteps(run);
  if (steps.length === 0) return null;
  return (
    <ol className="flex min-w-0 items-center gap-1" data-testid="factory-run-steps">
      {steps.map((step, index) => {
        const Icon = STEP_ICON[step.status];
        return (
          <li
            key={step.name}
            className="flex min-w-0 items-center gap-1"
            data-testid={`factory-run-step-${step.name}`}
            data-status={step.status}
          >
            {index > 0 && <ChevronRight className="icon-xs text-muted-foreground shrink-0" />}
            <Icon
              className={cn(
                'icon-xs shrink-0',
                step.status === 'current' && 'animate-spin text-status-info',
                step.status === 'done' && 'text-status-success',
                step.status === 'failed' && 'text-status-error',
                step.status === 'pending' && 'text-muted-foreground',
              )}
            />
            <span
              className={cn(
                'truncate',
                step.status === 'pending' && 'text-muted-foreground',
                step.status === 'current' && 'font-medium',
                step.status === 'failed' && 'font-medium text-status-error',
              )}
            >
              {step.name}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function FactoryRunBanner({ projectId, threadId }: { projectId: string; threadId: string }) {
  const { t } = useTranslation();
  const run = useFactoryRunForThread(projectId, threadId);
  const canSteer = useCanSteerProject(projectId);
  if (!run) return null;

  const control = (action: 'stop' | 'retry') =>
    void controlFactoryRun(action, projectId, run.id).orTee((error) =>
      toastError(error, 'factory'),
    );
  const failed = run.state === 'failed' || run.failureReason !== null;

  return (
    <div
      className={cn(
        'flex flex-col gap-1 border-b px-3 py-1.5 text-xs',
        failed ? 'border-status-error/20 bg-status-error/5' : 'bg-muted/30',
      )}
      data-testid="factory-run-banner"
    >
      <div className="flex min-w-0 items-center gap-2">
        <span className="shrink-0 font-medium">
          {t('factory.banner.title', 'Factory · #{{issue}}', { issue: run.issueNumber })}
        </span>
        {run.flowName && (
          <span className="text-muted-foreground shrink-0" data-testid="factory-run-flow">
            {run.flowName}
          </span>
        )}
        <StepChain run={run} />
        <span className="ml-auto flex shrink-0 items-center gap-1">
          <Badge size="xs" variant={factoryRunStateVariant(run.state)}>
            {factoryRunStateLabel(t, run.state)}
          </Badge>
          {run.prUrl && (
            <Button asChild size="xs" variant="link" data-testid="factory-run-banner-pr">
              <a href={run.prUrl} target="_blank" rel="noreferrer">
                {t('factory.pullRequest', 'PR')}
              </a>
            </Button>
          )}
          {canSteer && RETRYABLE.has(run.state) && (
            <Button
              size="xs"
              variant="outline"
              data-testid="factory-run-banner-retry"
              onClick={() => control('retry')}
            >
              {t('factory.retry', 'Retry')}
            </Button>
          )}
          {canSteer && !ENDED_FACTORY_STATES.has(run.state) && (
            <Button
              size="xs"
              variant="ghost"
              data-testid="factory-run-banner-stop"
              onClick={() => control('stop')}
            >
              {t('factory.stop', 'Stop')}
            </Button>
          )}
        </span>
      </div>
      {run.failureReason && (
        <p className="text-status-error" data-testid="factory-run-failure">
          {run.failureReason}
        </p>
      )}
    </div>
  );
}
