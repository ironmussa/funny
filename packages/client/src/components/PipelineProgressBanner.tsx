import { CheckCircle2, XCircle, Loader2, Eye, Wrench, Shield } from 'lucide-react';

import { cn } from '@/lib/utils';
import { usePipelineStore } from '@/stores/pipeline-store';

const stageIcons: Record<string, typeof Eye> = {
  reviewer: Eye,
  corrector: Wrench,
  fixer: Shield,
};

const stageLabels: Record<string, string> = {
  reviewer: 'Reviewing',
  corrector: 'Fixing',
  fixer: 'Pre-commit fixing',
};

export function PipelineProgressBanner({ threadId }: { threadId: string }) {
  const run = usePipelineStore((s) => s.activeRuns[threadId]);

  if (!run) return null;

  const isDone = run.status === 'completed' || run.status === 'skipped';
  const isFailed = run.status === 'failed';
  const isRunning = !isDone && !isFailed;

  const StageIcon = stageIcons[run.currentStage] ?? Eye;
  const stageLabel = stageLabels[run.currentStage] ?? run.currentStage;

  return (
    <div
      className={cn(
        'flex items-center gap-2 border-b px-3 py-1.5 text-xs',
        isDone && 'border-status-success/20 bg-status-success/5 text-status-success',
        isFailed && 'border-status-error/20 bg-status-error/5 text-status-error',
        isRunning && 'border-status-info/20 bg-status-info/5 text-status-info',
      )}
      data-testid="pipeline-progress-banner"
    >
      {/* Status icon */}
      {isDone ? (
        <CheckCircle2 className="h-3.5 w-3.5" />
      ) : isFailed ? (
        <XCircle className="h-3.5 w-3.5" />
      ) : (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      )}

      {/* Pipeline label */}
      <span className="font-medium">Pipeline</span>

      {/* Stage indicator */}
      {isRunning && (
        <>
          <span className="text-muted-foreground">·</span>
          <StageIcon className="h-3 w-3" />
          <span>{stageLabel}</span>
        </>
      )}

      {/* Iteration count */}
      {run.iteration > 0 && (
        <>
          <span className="text-muted-foreground">·</span>
          <span className="text-muted-foreground">
            Iteration {run.iteration}/{run.maxIterations ?? 10}
          </span>
        </>
      )}

      {/* Status text */}
      {isDone && <span>All checks passed</span>}
      {isFailed && <span>{run.hookError || 'Max iterations reached'}</span>}
    </div>
  );
}
