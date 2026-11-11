import { CheckCircle2, Circle, Loader2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { LoadingState } from '@/components/ui/loading-state';
import { cn } from '@/lib/utils';

// Pieces shared by the live progress widgets (test-progress, task-progress).

export type TFunction = ReturnType<typeof useTranslation>['t'];

export type ProgressStatus = 'queued' | 'running' | 'passed' | 'failed';

/** Result colors, as in vitest / jest: pass green, fail red, skip / warn yellow-amber. */
export const TONE = {
  passed: 'text-green-500',
  failed: 'text-red-500',
  skipped: 'text-amber-500',
} as const;

const STATUS_ICON: Record<ProgressStatus, { icon: typeof Circle; className: string }> = {
  queued: { icon: Circle, className: 'text-muted-foreground' },
  running: { icon: Loader2, className: 'animate-spin text-primary' },
  passed: { icon: CheckCircle2, className: TONE.passed },
  failed: { icon: XCircle, className: TONE.failed },
};

export function StatusIcon({ status, className }: { status: ProgressStatus; className?: string }) {
  const { icon: Icon, className: tone } = STATUS_ICON[status];
  return <Icon className={cn('size-3.5 shrink-0', tone, className)} aria-hidden />;
}

export function formatDuration(ms: number, t: TFunction): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return t('duration.seconds', { count: total });
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return t('duration.minutesSeconds', { minutes, seconds: total % 60 });
  return t('duration.hoursMinutes', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
}

/** Re-renders every second while `running`, so elapsed times tick. */
export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [running]);
  return now;
}

/** Elapsed time of a run: until it finished, or until now while running. */
export function runElapsed(
  run: { status: string; startedAt: number; updatedAt: number; finishedAt?: number },
  now: number,
): number {
  const end = run.finishedAt ?? (run.status === 'running' ? now : run.updatedAt);
  return end - run.startedAt;
}

/** What a progress block shows before its first snapshot, or when it has none. */
export function ProgressFileFallback({
  kind,
  path,
  testIdPrefix,
}: {
  kind: 'loading' | 'error';
  path: string | null;
  testIdPrefix: string;
}) {
  const { t } = useTranslation();
  if (kind === 'loading') {
    return (
      <LoadingState
        layout="inline"
        fill={false}
        label={t('progressFile.loading')}
        testId={`${testIdPrefix}-loading`}
      />
    );
  }
  return (
    <div
      data-testid={`${testIdPrefix}-error`}
      className="text-muted-foreground rounded-md border border-dashed p-3 text-sm"
    >
      {path ? t('progressFile.unreadable', { path }) : t('progressFile.invalidFence')}
    </div>
  );
}
