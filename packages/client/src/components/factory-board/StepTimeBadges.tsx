/** Time on the board (openspec factory-step-timings): a run's time in its step, and a stage's median. */
import { useTranslation } from 'react-i18next';

import type { FactoryRun } from '@/lib/api/factory';

import { formatStepDuration, timeInCurrentStep } from './step-timings';

/** "In review 2h", or "Waiting for merge 20m" when the step has not started (its slot): the card's footer time. */
export function FactoryRunTimeInStep({ run, now }: { run: FactoryRun; now: number }) {
  const { t } = useTranslation();
  const time = timeInCurrentStep(run);
  if (!time || !run.currentStep) return null;
  const duration = formatStepDuration(Math.max(0, now - time.since));
  return (
    <span className="whitespace-nowrap" data-testid={`factory-board-time-${run.id}`}>
      {time.kind === 'in-step'
        ? t('factoryBoard.time.inStep', 'In {{step}} {{duration}}', {
            step: run.currentStep,
            duration,
          })
        : t('factoryBoard.time.waiting', 'Waiting for {{step}} {{duration}}', {
            step: run.currentStep,
            duration,
          })}
    </span>
  );
}

/** A column's median time in its stage over the last week. */
export function StageMedian({
  column,
  medianMs,
}: {
  column: string;
  medianMs: number | undefined;
}) {
  const { t } = useTranslation();
  if (medianMs === undefined) return null;
  return (
    <span
      className="text-muted-foreground text-xs tabular-nums"
      title={t('factoryBoard.time.medianTitle', 'Median time in this stage, last 7 days')}
      data-testid={`factory-board-median-${column}`}
    >
      ~{formatStepDuration(medianMs)}
    </span>
  );
}
