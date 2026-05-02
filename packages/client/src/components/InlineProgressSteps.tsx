import { Check, ExternalLink, Loader2, X } from 'lucide-react';
import { useMemo } from 'react';

import {
  formatElapsed,
  SubItemsList,
  type GitProgressStep,
  useStepTimers,
  useTotalFromSteps,
} from '@/components/GitProgressModal';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

interface InlineProgressStepsProps {
  steps: GitProgressStep[];
  /** Whether to show total elapsed time at the bottom. Defaults to true. */
  showTotal?: boolean;
}

export function InlineProgressSteps({ steps, showTotal = true }: InlineProgressStepsProps) {
  // Filter out pending steps — only show steps that have actually started, completed, or failed
  const visibleSteps = useMemo(() => steps.filter((s) => s.status !== 'pending'), [steps]);

  // Pass open=true since inline steps are always visible when rendered
  const getStepElapsed = useStepTimers(steps, true);
  const totalElapsed = useTotalFromSteps(steps, getStepElapsed);

  return (
    <div className="space-y-2">
      {visibleSteps.map((step) => {
        const stepElapsed = getStepElapsed(step.id);
        return (
          <div
            key={step.id}
            className={cn(
              'flex items-start gap-2.5 rounded-md px-2 py-1 transition-colors',
              step.status === 'running' && 'bg-primary/8',
            )}
          >
            <div className="mt-0.5 flex-shrink-0">
              {step.status === 'completed' && <Check className="icon-base text-emerald-500" />}
              {step.status === 'running' && (
                <Loader2 className="icon-base animate-spin text-primary" />
              )}
              {step.status === 'failed' && <X className="icon-base text-destructive" />}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <span
                  className={cn(
                    'text-xs',
                    step.status === 'completed' && 'text-muted-foreground',
                    step.status === 'running' && 'font-medium text-foreground',
                    step.status === 'failed' && 'font-medium text-destructive',
                  )}
                >
                  {step.label}
                </span>
                {stepElapsed != null && (
                  <span className="flex-shrink-0 text-[10px] tabular-nums text-muted-foreground/60">
                    {formatElapsed(stepElapsed)}
                  </span>
                )}
              </div>
              {step.url && step.status === 'completed' && (
                <a
                  href={step.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-0.5 flex items-center gap-1 text-[11px] text-primary hover:underline"
                >
                  <ExternalLink className="icon-xs" />
                  {step.url}
                </a>
              )}
              {step.subItems && step.subItems.length > 0 && (
                <SubItemsList subItems={step.subItems} parentStatus={step.status} />
              )}
              {step.error && !(step.subItems && step.subItems.length > 0) && (
                <ScrollArea className="mt-0.5 max-h-40 rounded bg-destructive/5">
                  <pre className="whitespace-pre-wrap break-words p-1.5 font-mono text-[11px] text-destructive/80">
                    {step.error}
                  </pre>
                </ScrollArea>
              )}
            </div>
          </div>
        );
      })}
      {showTotal && visibleSteps.length > 0 && (
        <div className="flex justify-end">
          <span className="text-[10px] tabular-nums text-muted-foreground/50">
            {formatElapsed(totalElapsed)}
          </span>
        </div>
      )}
    </div>
  );
}
