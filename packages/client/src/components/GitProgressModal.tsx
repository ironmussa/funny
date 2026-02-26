import { Check, Circle, Loader2, X, ExternalLink } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

export interface GitProgressStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
  /** Optional URL to display on completion (e.g., PR link) */
  url?: string;
}

interface GitProgressModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  steps: GitProgressStep[];
  title: string;
}

function formatElapsed(ms: number) {
  const totalSeconds = ms / 1000;
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  if (m > 0) {
    return `${m}:${Math.floor(s).toString().padStart(2, '0')}`;
  }
  return `${s.toFixed(1)}s`;
}

/** Tracks per-step elapsed time based on step status transitions. */
function useStepTimers(steps: GitProgressStep[], open: boolean) {
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

  // Track status transitions
  useEffect(() => {
    const now = Date.now();
    for (const step of steps) {
      if (step.status === 'running' && !startTimes.current.has(step.id)) {
        startTimes.current.set(step.id, now);
        endTimes.current.delete(step.id);
      }
      if (
        (step.status === 'completed' || step.status === 'failed') &&
        !endTimes.current.has(step.id) &&
        startTimes.current.has(step.id)
      ) {
        endTimes.current.set(step.id, now);
      }
      // If a step went back to pending (e.g. commit reset on hook failure), clear its timers
      if (step.status === 'pending') {
        startTimes.current.delete(step.id);
        endTimes.current.delete(step.id);
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

/** Tracks total elapsed time (in ms) while the modal is open and running. */
function useTotalTimer(open: boolean, isFinished: boolean) {
  const startRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (open && !isFinished) {
      startRef.current = Date.now();
      setElapsed(0);
      const interval = setInterval(() => {
        if (startRef.current) {
          setElapsed(Date.now() - startRef.current);
        }
      }, 100);
      return () => clearInterval(interval);
    }
  }, [open, isFinished]);

  return elapsed;
}

export function GitProgressModal({ open, onOpenChange, steps, title }: GitProgressModalProps) {
  const { t } = useTranslation();
  const isRunning = steps.some((s) => s.status === 'running');
  const hasFailed = steps.some((s) => s.status === 'failed');
  // Finished = nothing running AND (all done/failed, OR one failed with remaining pending)
  const isFinished =
    steps.length > 0 &&
    !isRunning &&
    (steps.every((s) => s.status === 'completed' || s.status === 'failed') || hasFailed);

  const getStepElapsed = useStepTimers(steps, open);
  const totalElapsed = useTotalTimer(open, isFinished);

  return (
    <Dialog open={open} onOpenChange={isFinished ? onOpenChange : undefined}>
      <DialogContent
        className="max-w-sm"
        onPointerDownOutside={(e) => {
          if (!isFinished) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-sm">{title}</DialogTitle>
          <DialogDescription className="sr-only">
            {t('review.progress.description', 'Git operation progress')}
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] space-y-2 overflow-auto">
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
                  {step.status === 'pending' && (
                    <Circle className="h-4 w-4 text-muted-foreground/40" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <span
                      className={cn(
                        'text-xs',
                        step.status === 'completed' && 'text-muted-foreground',
                        step.status === 'running' && 'text-foreground font-medium',
                        step.status === 'failed' && 'text-destructive font-medium',
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
                    <pre className="mt-0.5 max-h-40 overflow-auto break-words whitespace-pre-wrap text-[11px] text-destructive/80 font-sans">
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
        </div>
        <div className="flex flex-col items-end gap-2">
          <span className="text-[10px] tabular-nums text-muted-foreground/50">
            {formatElapsed(totalElapsed)}
          </span>
          {isFinished && (
            <Button
              size="sm"
              variant={hasFailed ? 'outline' : 'default'}
              onClick={() => onOpenChange(false)}
            >
              {hasFailed ? t('common.cancel', 'Close') : t('review.progress.done', 'Done')}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
