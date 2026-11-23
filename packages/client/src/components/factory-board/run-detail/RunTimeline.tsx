/**
 * The run panel's step timeline (openspec factory-step-timings): each flow
 * node execution in start order with its status and duration, and the waits
 * of a minute or more between them.
 */
import type { FactoryStepTimingStatus } from '@funny/shared/contracts/factory';
import { useTranslation } from 'react-i18next';

import { LabelBadge, type LabelBadgeTone } from '@/components/ui/label-badge';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import type { FactoryQueueRun } from '@/lib/api/factory';

import { formatStepDuration, stepTimeline } from '../step-timings';
import { DetailSection } from './sections';

const STATUS_TONE: Record<FactoryStepTimingStatus, LabelBadgeTone> = {
  running: 'info',
  succeeded: 'success',
  failed: 'danger',
  skipped: 'neutral',
  cancelled: 'neutral',
};

export function RunTimeline({ run }: { run: FactoryQueueRun }) {
  const { t } = useTranslation();
  const now = useMinuteTick();
  const entries = stepTimeline(run, now);
  if (entries.length === 0) return null;
  const statuses: Record<FactoryStepTimingStatus, string> = {
    running: t('factoryRunDetail.timeline.running', 'running'),
    succeeded: t('factoryRunDetail.timeline.succeeded', 'done'),
    failed: t('factoryRunDetail.timeline.failed', 'failed'),
    skipped: t('factoryRunDetail.timeline.skipped', 'skipped'),
    cancelled: t('factoryRunDetail.timeline.cancelled', 'cancelled'),
  };
  return (
    <DetailSection id="timeline" title={t('factoryRunDetail.timeline.title', 'Timeline')}>
      <ol className="flex flex-col gap-0.5">
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
      </ol>
    </DetailSection>
  );
}
