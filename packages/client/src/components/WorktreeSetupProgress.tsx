import { Check, Circle, Loader2, X } from 'lucide-react';
import { m, AnimatePresence, useReducedMotion } from 'motion/react';
import { useMemo } from 'react';

import {
  formatElapsed,
  type GitProgressStep,
  useStepTimers,
  useTotalFromSteps,
} from '@/components/GitProgressModal';
import { LoadingState } from '@/components/ui/loading-state';
import { cn } from '@/lib/utils';

interface WorktreeSetupProgressProps {
  steps: GitProgressStep[];
}

const STEP_STYLE = {
  running: {
    Icon: Loader2,
    icon: 'text-primary size-6 animate-spin',
    label: 'text-foreground',
    dot: 'bg-primary',
  },
  completed: {
    Icon: Check,
    icon: 'size-6 text-emerald-500',
    label: 'text-emerald-500',
    dot: 'bg-emerald-500',
  },
  failed: {
    Icon: X,
    icon: 'text-destructive size-6',
    label: 'text-destructive',
    dot: 'bg-destructive',
  },
  pending: {
    Icon: Circle,
    icon: 'text-muted-foreground/40 size-6',
    label: 'text-muted-foreground/60',
    dot: 'bg-muted-foreground/20',
  },
};

export function WorktreeSetupProgress({ steps }: WorktreeSetupProgressProps) {
  const prefersReducedMotion = useReducedMotion();
  const getStepElapsed = useStepTimers(steps, true);
  const totalElapsed = useTotalFromSteps(steps, getStepElapsed);

  const focalStep = useMemo(() => selectFocalStep(steps), [steps]);

  const completedCount = steps.filter((s) => s.status === 'completed').length;

  // Empty state while waiting for first WS event
  if (!focalStep) {
    return <LoadingState testId="worktree-setup-progress" label="Preparing…" />;
  }

  const stepElapsed = getStepElapsed(focalStep.id);
  const style = STEP_STYLE[focalStep.status];
  const Icon = style.Icon;

  return (
    <div
      className="flex w-full max-w-md flex-col items-center justify-center gap-6"
      data-testid="worktree-setup-progress"
    >
      {/* Focal step with animation */}
      <div className="flex min-h-[100px] w-full items-center justify-center">
        <AnimatePresence mode="wait">
          <m.div
            key={focalStep.id + '-' + focalStep.status}
            initial={prefersReducedMotion ? false : { opacity: 0, y: 12, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={prefersReducedMotion ? undefined : { opacity: 0, y: -16 }}
            transition={{ duration: 0.3, ease: 'easeOut' }}
            className="flex flex-col items-center gap-3"
            data-testid={`worktree-setup-step-${focalStep.id}`}
          >
            {/* Icon */}
            <div className="shrink-0">
              <Icon className={style.icon} />
            </div>

            {/* Label */}
            <span className={cn('text-center text-sm font-normal', style.label)}>
              {focalStep.label}
            </span>

            {/* Per-step elapsed */}
            {stepElapsed != null && focalStep.status !== 'pending' && (
              <span className="text-muted-foreground/50 text-sm tabular-nums">
                {formatElapsed(stepElapsed)}
              </span>
            )}

            {/* Error message */}
            {focalStep.error && (
              <pre className="bg-destructive/5 text-destructive/80 mt-1 max-h-40 max-w-full overflow-auto rounded-md p-3 font-mono text-xs wrap-break-word whitespace-pre-wrap">
                {focalStep.error}
              </pre>
            )}
          </m.div>
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
                STEP_STYLE[step.status].dot,
              )}
            />
          ))}
        </div>
      )}

      <SetupElapsed count={steps.length} completed={completedCount} elapsed={totalElapsed} />
    </div>
  );
}

function selectFocalStep(steps: GitProgressStep[]) {
  const running = steps.find((s) => s.status === 'running');
  if (running) return running;
  const done = steps.filter((s) => s.status === 'completed' || s.status === 'failed');
  return done.length > 0 ? done[done.length - 1] : (steps[0] ?? null);
}

function SetupElapsed({
  count,
  completed,
  elapsed,
}: {
  count: number;
  completed: number;
  elapsed: number;
}) {
  if (count === 0) return null;
  return (
    <span className="text-muted-foreground/40 text-xs tabular-nums">
      {completed === count ? `Completed in ${formatElapsed(elapsed)}` : formatElapsed(elapsed)}
    </span>
  );
}
