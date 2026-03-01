import { Check, Circle, ExternalLink, Loader2, X } from 'lucide-react';

import {
  formatElapsed,
  type GitProgressStep,
  useStepTimers,
  useTotalFromSteps,
} from '@/components/GitProgressModal';
import { cn } from '@/lib/utils';

interface InlineProgressStepsProps {
  steps: GitProgressStep[];
  /** Whether to show total elapsed time at the bottom. Defaults to true. */
  showTotal?: boolean;
}

export function InlineProgressSteps({ steps, showTotal = true }: InlineProgressStepsProps) {
  // Pass open=true since inline steps are always visible when rendered
  const getStepElapsed = useStepTimers(steps, true);
  const totalElapsed = useTotalFromSteps(steps, getStepElapsed);

  return (
    <div className="space-y-2">
      {steps.map((step) => {
        const stepElapsed = getStepElapsed(step.id);
        return (
          <div key={step.id} className="flex items-center gap-2.5">
            <div className="flex-shrink-0">
              {step.status === 'completed' && <Check className="h-4 w-4 text-emerald-500" />}
              {step.status === 'running' && (
                <Loader2 className="h-4 w-4 animate-spin text-primary" />
              )}
              {step.status === 'failed' && <X className="h-4 w-4 text-destructive" />}
              {step.status === 'pending' && <Circle className="h-4 w-4 text-muted-foreground/40" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    'text-xs',
                    step.status === 'completed' && 'text-muted-foreground',
                    step.status === 'running' && 'font-medium text-foreground',
                    step.status === 'failed' && 'font-medium text-destructive',
                    step.status === 'pending' && 'text-muted-foreground/60',
                  )}
                >
                  {step.label}
                </span>
                {stepElapsed != null && step.status !== 'pending' && (
                  <span className="flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                    {formatElapsed(stepElapsed)}
                  </span>
                )}
              </div>
              {step.error && (
                <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-destructive/5 p-1.5 font-mono text-[11px] text-destructive/80">
                  {step.error}
                </pre>
              )}
              {step.url && step.status === 'completed' && (
                <a
                  href={step.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-0.5 flex items-center gap-1 text-[11px] text-primary hover:underline"
                >
                  <ExternalLink className="h-3 w-3" />
                  {step.url}
                </a>
              )}
            </div>
          </div>
        );
      })}
      {showTotal && steps.length > 0 && (
        <div className="flex justify-end">
          <span className="text-[10px] tabular-nums text-muted-foreground/50">
            {formatElapsed(totalElapsed)}
          </span>
        </div>
      )}
    </div>
  );
}
