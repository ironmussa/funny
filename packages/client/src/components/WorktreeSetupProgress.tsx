import { Check, Circle, Loader2, X } from 'lucide-react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { useMemo } from 'react';

import {
  formatElapsed,
  type GitProgressStep,
  useStepTimers,
  useTotalFromSteps,
} from '@/components/GitProgressModal';
import { cn } from '@/lib/utils';

interface WorktreeSetupProgressProps {
  steps: GitProgressStep[];
}

export function WorktreeSetupProgress({ steps }: WorktreeSetupProgressProps) {
  const prefersReducedMotion = useReducedMotion();
  const getStepElapsed = useStepTimers(steps, true);
  const totalElapsed = useTotalFromSteps(steps, getStepElapsed);

  const focalStep = useMemo(() => {
    const running = steps.find((s) => s.status === 'running');
    if (running) return running;
    const done = steps.filter((s) => s.status === 'completed' || s.status === 'failed');
    return done.length > 0 ? done[done.length - 1] : (steps[0] ?? null);
  }, [steps]);

  const completedCount = steps.filter((s) => s.status === 'completed').length;

  // Empty state while waiting for first WS event
  if (!focalStep) {
    return (
      <div
        className="flex w-full max-w-md flex-col items-center justify-center gap-4"
        data-testid="worktree-setup-progress"
      >
        <Loader2 className="size-8 animate-spin text-muted-foreground/50" />
        <span className="text-sm text-muted-foreground/60">Preparing…</span>
      </div>
    );
  }

  const stepElapsed = getStepElapsed(focalStep.id);

  return (
    <div
      className="flex w-full max-w-md flex-col items-center justify-center gap-6"
      data-testid="worktree-setup-progress"
    >
      {/* Focal step with animation */}
      <div className="flex min-h-[100px] w-full items-center justify-center">
        <AnimatePresence mode="wait">
          <motion.div
            key={focalStep.id + '-' + focalStep.status}
            initial={prefersReducedMotion ? false : { opacity: 0, y: 12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={prefersReducedMotion ? undefined : { opacity: 0, y: -16 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="flex flex-col items-center gap-3"
            data-testid={`worktree-setup-step-${focalStep.id}`}
          >
            {/* Icon */}
            <div className="flex-shrink-0">
              {focalStep.status === 'running' && (
                <Loader2 className="size-8 animate-spin text-primary" />
              )}
              {focalStep.status === 'completed' && <Check className="size-8 text-emerald-500" />}
              {focalStep.status === 'failed' && <X className="size-8 text-destructive" />}
              {focalStep.status === 'pending' && (
                <Circle className="size-8 text-muted-foreground/40" />
              )}
            </div>

            {/* Label */}
            <span
              className={cn(
                'text-center text-lg font-medium',
                focalStep.status === 'completed' && 'text-emerald-500',
                focalStep.status === 'running' && 'text-foreground',
                focalStep.status === 'failed' && 'text-destructive',
                focalStep.status === 'pending' && 'text-muted-foreground/60',
              )}
            >
              {focalStep.label}
            </span>

            {/* Per-step elapsed */}
            {stepElapsed != null && focalStep.status !== 'pending' && (
              <span className="text-sm tabular-nums text-muted-foreground/50">
                {formatElapsed(stepElapsed)}
              </span>
            )}

            {/* Error message */}
            {focalStep.error && (
              <pre className="mt-1 max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-words rounded-md bg-destructive/5 p-3 font-mono text-xs text-destructive/80">
                {focalStep.error}
              </pre>
            )}
          </motion.div>
        </AnimatePresence>
      </div>

      {/* Step dots indicator */}
      {steps.length > 1 && (
        <div className="flex items-center gap-2" data-testid="worktree-setup-dots">
          {steps.map((step) => (
            <div
              key={step.id}
              className={cn(
                'size-2 rounded-full transition-colors duration-300',
                step.status === 'completed' && 'bg-emerald-500',
                step.status === 'running' && 'bg-primary',
                step.status === 'failed' && 'bg-destructive',
                step.status === 'pending' && 'bg-muted-foreground/20',
              )}
            />
          ))}
        </div>
      )}

      {/* Total elapsed */}
      {steps.length > 0 && (
        <span className="text-xs tabular-nums text-muted-foreground/40">
          {completedCount === steps.length && steps.length > 0
            ? `Completed in ${formatElapsed(totalElapsed)}`
            : formatElapsed(totalElapsed)}
        </span>
      )}
    </div>
  );
}
