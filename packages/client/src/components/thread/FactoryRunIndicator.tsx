/**
 * The issue factory run a factory thread belongs to, as an icon in the prompt's
 * footer: the trigger shows the step the run is on (red when it failed), and
 * its popover lists every step of the flow with how far the run got, the run's
 * state, its pull request, why it failed, and the member's controls (retry a
 * failed or parked run, stop one in flight). Without it a thread could keep
 * working after its run had already failed, with nothing saying so (#343).
 */
import { Check, Circle, Factory, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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

const STEP_TONE: Record<FactoryStepStatus, string> = {
  done: 'text-status-success',
  current: 'animate-spin text-status-info',
  failed: 'text-status-error',
  pending: 'text-muted-foreground',
};

function StepList({ run }: { run: FactoryRun }) {
  const steps = factoryRunSteps(run);
  if (steps.length === 0) return null;
  return (
    <ol className="flex flex-col gap-1" data-testid="factory-run-steps">
      {steps.map((step) => {
        const Icon = STEP_ICON[step.status];
        return (
          <li
            key={step.name}
            className="flex items-center gap-2"
            data-testid={`factory-run-step-${step.name}`}
            data-status={step.status}
          >
            <Icon className={cn('icon-xs shrink-0', STEP_TONE[step.status])} />
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

/** The step the trigger names: the current or failed one, else the run's state. */
function triggerLabel(run: FactoryRun): string | null {
  const step = factoryRunSteps(run).find((s) => s.status === 'current' || s.status === 'failed');
  return step?.name ?? null;
}

export function FactoryRunIndicator({
  projectId,
  threadId,
}: {
  projectId: string;
  threadId: string;
}) {
  const { t } = useTranslation();
  const run = useFactoryRunForThread(projectId, threadId);
  const canSteer = useCanSteerProject(projectId);
  if (!run) return null;

  const control = (action: 'stop' | 'retry') =>
    void controlFactoryRun(action, projectId, run.id).orTee((error) =>
      toastError(error, 'factory'),
    );
  const failed = run.state === 'failed' || run.failureReason !== null;
  const stateLabel = factoryRunStateLabel(t, run.state);
  const label = triggerLabel(run) ?? stateLabel;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex shrink-0 items-center gap-1 rounded px-1 text-xs leading-none hover:bg-accent',
            failed ? 'text-status-error' : 'text-muted-foreground',
          )}
          aria-label={t('factory.indicator.label', 'Factory run: {{step}}', { step: label })}
          data-testid="factory-run-indicator"
        >
          <Factory className="icon-xs" />
          <span className="max-w-32 truncate">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        className="w-72 text-xs"
        data-testid="factory-run-popover"
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="font-medium">
              {t('factory.banner.title', 'Factory · #{{issue}}', { issue: run.issueNumber })}
            </span>
            <Badge size="xs" variant={factoryRunStateVariant(run.state)} className="ml-auto">
              {stateLabel}
            </Badge>
          </div>
          {run.flowName && (
            <span className="text-muted-foreground" data-testid="factory-run-flow">
              {run.flowName}
            </span>
          )}
          <StepList run={run} />
          {run.failureReason && (
            <p className="text-status-error break-words" data-testid="factory-run-failure">
              {run.failureReason}
            </p>
          )}
          <div className="flex items-center gap-1">
            {run.prUrl && (
              <Button asChild size="xs" variant="link" data-testid="factory-run-pr">
                <a href={run.prUrl} target="_blank" rel="noreferrer">
                  {t('factory.pullRequest', 'PR')}
                </a>
              </Button>
            )}
            <span className="ml-auto flex items-center gap-1">
              {canSteer && RETRYABLE.has(run.state) && (
                <Button
                  size="xs"
                  variant="outline"
                  data-testid="factory-run-retry"
                  onClick={() => control('retry')}
                >
                  {t('factory.retry', 'Retry')}
                </Button>
              )}
              {canSteer && !ENDED_FACTORY_STATES.has(run.state) && (
                <Button
                  size="xs"
                  variant="ghost"
                  data-testid="factory-run-stop"
                  onClick={() => control('stop')}
                >
                  {t('factory.stop', 'Stop')}
                </Button>
              )}
            </span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
