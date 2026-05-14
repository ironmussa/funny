import { ArrowRight, Check, Loader2, Minus, X, ExternalLink } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import type { GitProgressStep, GitProgressSubItem, SubItemStatus } from '@/lib/git-progress-types';
import { cn } from '@/lib/utils';

export type { GitProgressStep, GitProgressSubItem, SubItemStatus };

interface GitProgressModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  steps: GitProgressStep[];
  title: string;
  /** When true, the modal auto-closes on success (no Done button). Failures still show Accept. */
  autoClose?: boolean;
}

export function formatElapsed(ms: number) {
  const totalSeconds = ms / 1000;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m > 0) {
    return `${m}:${Math.floor(s).toString().padStart(2, '0')}`;
  }
  return `${s.toFixed(1)}s`;
}

/** Tracks per-step elapsed time based on step status transitions. */
export function useStepTimers(steps: GitProgressStep[], open: boolean) {
  const startTimes = useRef<Map<string, number>>(new Map());
  const endTimes = useRef<Map<string, number>>(new Map());
  const [, tick] = useState(0);

  // Reset all timers when the modal opens with a fresh set of steps
  useEffect(() => {
    if (open) {
      startTimes.current.clear();
      endTimes.current.clear();
    }
  }, [open]);

  // Track status transitions — seed from persisted timestamps when available
  useEffect(() => {
    const now = Date.now();
    const startMap = startTimes.current;
    const endMap = endTimes.current;
    for (const step of steps) {
      if (step.status === 'running' && !startMap.has(step.id)) {
        startMap.set(step.id, step.startedAt ?? now);
        endMap.delete(step.id);
      }
      if ((step.status === 'completed' || step.status === 'failed') && !endMap.has(step.id)) {
        // Seed both start and end from persisted timestamps if available
        if (!startMap.has(step.id) && step.startedAt) {
          startMap.set(step.id, step.startedAt);
        }
        if (startMap.has(step.id)) {
          endMap.set(step.id, step.completedAt ?? now);
        }
      }
      // If a step went back to pending (e.g. commit reset on hook failure), clear its timers
      if (step.status === 'pending') {
        startMap.delete(step.id);
        endMap.delete(step.id);
      }
    }
  }, [steps]);

  // Tick every second while any step is running
  const hasRunning = steps.some((s) => s.status === 'running');
  useEffect(() => {
    if (!hasRunning) return;
    const interval = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(interval);
  }, [hasRunning]);

  return (stepId: string): number | null => {
    const start = startTimes.current.get(stepId);
    if (start == null) return null;
    const end = endTimes.current.get(stepId) ?? Date.now();
    return end - start;
  };
}

/** Computes total elapsed as the sum of all individual step times. */
export function useTotalFromSteps(
  steps: GitProgressStep[],
  getStepElapsed: (id: string) => number | null,
) {
  const [, tick] = useState(0);
  const hasRunning = steps.some((s) => s.status === 'running');

  useEffect(() => {
    if (!hasRunning) return;
    const interval = setInterval(() => tick((n) => n + 1), 100);
    return () => clearInterval(interval);
  }, [hasRunning]);

  let total = 0;
  for (const step of steps) {
    const elapsed = getStepElapsed(step.id);
    if (elapsed != null) total += elapsed;
  }
  return total;
}

/** Renders sub-items with individual status icons (shared by modal and inline views). */
export function SubItemsList({
  subItems,
  parentStatus,
}: {
  subItems: GitProgressSubItem[];
  parentStatus: GitProgressStep['status'];
}) {
  // Show sub-items when the parent is running, failed, or completed
  if (parentStatus === 'pending') return null;

  return (
    <div className="mt-1 space-y-0.5 pl-1">
      {subItems.map((item, i) => (
        <div
          key={i}
          className={cn(
            'flex items-center gap-1.5 text-[11px]',
            item.status === 'completed' && 'text-muted-foreground',
            item.status === 'running' && 'text-foreground',
            item.status === 'failed' && 'text-destructive',
            item.status === 'pending' && 'text-muted-foreground/40',
          )}
        >
          <div className="flex-shrink-0">
            {item.status === 'completed' && <Check className="icon-xs text-emerald-500" />}
            {item.status === 'running' && <ArrowRight className="icon-xs text-primary" />}
            {item.status === 'failed' && <X className="icon-xs text-destructive" />}
            {item.status === 'pending' && <Minus className="icon-xs text-muted-foreground/30" />}
          </div>
          <span className={cn('truncate font-mono', item.status === 'running' && 'font-medium')}>
            {item.label}
          </span>
          {item.error && (
            <pre className="mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-destructive/5 p-1.5 font-mono text-[11px] text-destructive/80">
              {item.error}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

export function GitProgressModal({
  open,
  onOpenChange,
  steps,
  title,
  autoClose,
}: GitProgressModalProps) {
  const { t } = useTranslation();
  const isRunning = steps.some((s) => s.status === 'running');
  const hasFailed = steps.some((s) => s.status === 'failed');
  // Finished = nothing running AND (all done/failed, OR one failed with remaining pending)
  const isFinished =
    steps.length > 0 &&
    !isRunning &&
    (steps.every((s) => s.status === 'completed' || s.status === 'failed') || hasFailed);

  // Filter out pending steps — only show steps that have actually started
  const visibleSteps = useMemo(() => steps.filter((s) => s.status !== 'pending'), [steps]);

  const getStepElapsed = useStepTimers(steps, open);
  const totalElapsed = useTotalFromSteps(steps, getStepElapsed);

  // When autoClose is set, hide Done button on success (parent handles closing).
  // Failures always show Accept so the user can see the error.
  const showButton = isFinished && (!autoClose || hasFailed);

  return (
    <Dialog open={open} onOpenChange={isFinished ? onOpenChange : undefined}>
      <DialogContent
        className={cn(
          'flex max-h-[85vh] w-[calc(100vw-2rem)] max-w-lg flex-col gap-4 overflow-hidden [&>button.absolute]:hidden',
          hasFailed && 'max-w-2xl',
        )}
        onPointerDownOutside={(e) => {
          if (!isFinished) e.preventDefault();
        }}
      >
        <DialogHeader className="flex-shrink-0">
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('review.progress.description', 'Git operation progress')}
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
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
                        step.status === 'running' && 'text-foreground font-medium',
                        step.status === 'failed' && 'text-destructive font-medium',
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
                      data-testid="git-progress-pr-link"
                    >
                      <ExternalLink className="icon-xs" />
                      {step.url}
                    </a>
                  )}
                  {step.subItems && step.subItems.length > 0 && (
                    <SubItemsList subItems={step.subItems} parentStatus={step.status} />
                  )}
                  {step.error && !(step.subItems && step.subItems.length > 0) && (
                    <pre className="mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-destructive/5 p-1.5 font-mono text-[11px] text-destructive/80">
                      {step.error}
                    </pre>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <div className="flex flex-shrink-0 flex-col items-end gap-2">
          <span className="text-[10px] tabular-nums text-muted-foreground/50">
            {formatElapsed(totalElapsed)}
          </span>
          {showButton && (
            <Button
              size="sm"
              variant={hasFailed ? 'outline' : 'default'}
              onClick={() => onOpenChange(false)}
              data-testid="git-progress-done"
            >
              {hasFailed
                ? t('review.progress.accept', 'Accept')
                : t('review.progress.done', 'Done')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
