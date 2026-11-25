/**
 * The run panel's flow steps (openspec factory-step-timings): each flow node
 * execution in start order with its status and duration, the waits of a
 * minute or more between them, then the flow's steps the run has not reached.
 * One list for what the flow is and how far the run got.
 */
import type { FactoryStepTimingStatus } from '@funny/shared/contracts/factory';
import { useTranslation } from 'react-i18next';

import { LabelBadge, type LabelBadgeTone } from '@/components/ui/label-badge';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import type { FactoryQueueRun } from '@/lib/api/factory';
import type { FactoryStepStatus } from '@/lib/factory-run-labels';

import { factoryRunStrip } from '../run-progress';
import { formatStepDuration, stepTimeline } from '../step-timings';

const STATUS_TONE: Record<FactoryStepTimingStatus, LabelBadgeTone> = {
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  skipped: 'neutral',
  cancelled: 'neutral',
};

const STRIP_TONE: Record<FactoryStepStatus, LabelBadgeTone> = {
  done: 'success',
  current: 'info',
  failed: 'danger',
  pending: 'neutral',
};

/**
 * The flow's steps with no timing: the ones not reached yet, and for a run
 * from before step timings, every step with the status its strip gives it.
 */
function untimedSteps(run: FactoryQueueRun) {
  const timed = new Set((run.stepTimings ?? []).map((timing) => timing.step));
  return factoryRunStrip(run).filter((step) => !timed.has(step.name));
}

export function RunTimeline({ run }: { run: FactoryQueueRun }) {
  const { t } = useTranslation();
  const now = useMinuteTick();
  const entries = stepTimeline(run, now);
  const untimed = untimedSteps(run);
  if (entries.length === 0 && untimed.length === 0) return null;
  const statuses: Record<FactoryStepTimingStatus, string> = {
    running: t('factoryRunDetail.timeline.running', 'running'),
    succeeded: t('factoryRunDetail.timeline.succeeded', 'done'),
    failed: t('factoryRunDetail.timeline.failed', 'failed'),
    skipped: t('factoryRunDetail.timeline.skipped', 'skipped'),
    cancelled: t('factoryRunDetail.timeline.cancelled', 'cancelled'),
  };
  const stripStatuses: Record<FactoryStepStatus, string> = {
    done: t('factoryBoard.step.done', 'done'),
    current: t('factoryBoard.step.current', 'in progress'),
    failed: t('factoryBoard.step.failed', 'failed'),
    pending: t('factoryBoard.step.pending', 'not reached'),
  };
  return (
    <ol className="flex flex-col gap-0.5" data-testid="factory-run-detail-timeline">
      {entries.map(({ timing, durationMs, waitBeforeMs }, index) => (
        <li key={`${timing.step}-${timing.visit}-${timing.attempt}`} className="flex flex-col">
          {waitBeforeMs !== undefined && (
            <span className="pl-2 italic" data-testid={`factory-run-detail-wait-${index}`}>
              {t('factoryRunDetail.timeline.wait', 'waited {{duration}}', {
                duration: formatStepDuration(waitBeforeMs),
              })}
            </span>
          )}
          <span
            className="flex items-center gap-1.5"
            data-testid={`factory-run-detail-timing-${index}`}
          >
            <span className="text-foreground font-mono">{timing.step}</span>
            {timing.attempt > 1 && (
              <span>
                {t('factoryRunDetail.timeline.attempt', 'attempt {{attempt}}', {
                  attempt: timing.attempt,
                })}
              </span>
            )}
            <LabelBadge tone={STATUS_TONE[timing.status]}>{statuses[timing.status]}</LabelBadge>
            <span className="ml-auto tabular-nums">{formatStepDuration(durationMs)}</span>
          </span>
        </li>
      ))}
      {untimed.map((step) => (
        <li
          key={`untimed-${step.name}`}
          className="flex items-center gap-1.5"
          data-status={step.status}
          data-testid={`factory-run-detail-step-${step.name}`}
        >
          <span
            className={
              step.status === 'pending' ? 'text-muted-foreground/60 font-mono' : 'font-mono'
            }
          >
            {step.name}
          </span>
          {step.round !== undefined && <span>{step.round}</span>}
          {step.status !== 'pending' && (
            <LabelBadge tone={STRIP_TONE[step.status]}>{stripStatuses[step.status]}</LabelBadge>
          )}
        </li>
      ))}
    </ol>
  );
}
