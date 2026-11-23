/**
 * The run's flow as a strip of steps (openspec factory-pipeline-board): done,
 * current, failed or not reached, the review round, and on hover what the
 * step's agent ran with.
 */
import { useTranslation } from 'react-i18next';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { FactoryRun } from '@/lib/api/factory';
import type { FactoryStepStatus } from '@/lib/factory-run-labels';
import { cn } from '@/lib/utils';

import { factoryRunStrip } from './run-progress';

const DOT_CLASS: Record<FactoryStepStatus, string> = {
  done: 'bg-status-success',
  current: 'bg-status-info animate-pulse',
  failed: 'bg-status-error',
  pending: 'bg-muted-foreground/30',
};

export function FactoryRunProgress({ run }: { run: FactoryRun }) {
  const { t } = useTranslation();
  const steps = factoryRunStrip(run);
  if (steps.length === 0) return null;
  const statusLabel: Record<FactoryStepStatus, string> = {
    done: t('factoryBoard.step.done', 'done'),
    current: t('factoryBoard.step.current', 'in progress'),
    failed: t('factoryBoard.step.failed', 'failed'),
    pending: t('factoryBoard.step.pending', 'not reached'),
  };
  return (
    <ol
      className="flex flex-wrap items-center gap-x-2 gap-y-1"
      data-testid={`factory-board-progress-${run.id}`}
    >
      {steps.map((step) => (
        <li key={step.name} data-status={step.status}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className={cn(
                  'text-2xs flex items-center gap-1 rounded-sm',
                  step.status === 'pending' ? 'text-muted-foreground/60' : 'text-muted-foreground',
                  step.status === 'current' && 'text-foreground',
                )}
                data-testid={`factory-board-step-${run.id}-${step.name}`}
              >
                <span className={cn('size-1.5 shrink-0 rounded-full', DOT_CLASS[step.status])} />
                <span className="font-mono">{step.name}</span>
                {step.round !== undefined && <span>{step.round}</span>}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <div>
                {step.name} · {statusLabel[step.status]}
                {step.round !== undefined &&
                  ` · ${t('factoryBoard.step.round', 'round {{round}}', { round: step.round })}`}
              </div>
              {step.options && (
                <div className="text-muted-foreground">
                  {[step.options.provider, step.options.model, step.options.effort]
                    .filter(Boolean)
                    .join(' · ')}
                </div>
              )}
            </TooltipContent>
          </Tooltip>
        </li>
      ))}
    </ol>
  );
}
