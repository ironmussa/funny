/** The quality gates a run has results for, as chips (openspec factory-pipeline-board). */
import { useTranslation } from 'react-i18next';

import { LabelBadge, type LabelBadgeTone } from '@/components/ui/label-badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { FactoryRun } from '@/lib/api/factory';
import { cn } from '@/lib/utils';

import { factoryRunGateChips, type FactoryGateTone } from './run-gates';

const TONE: Record<FactoryGateTone, LabelBadgeTone> = {
  pass: 'success',
  fail: 'danger',
  warn: 'warning',
  neutral: 'neutral',
};

export function FactoryRunGateChips({ run }: { run: FactoryRun }) {
  const { t } = useTranslation();
  const chips = factoryRunGateChips(t, run);
  if (chips.length === 0) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      data-testid={`factory-board-gates-${run.id}`}
    >
      {chips.map((chip) => {
        const badge = (
          <span className={cn('inline-flex', chip.stale && 'opacity-60')}>
            <LabelBadge
              tone={chip.stale ? 'neutral' : TONE[chip.tone]}
              data-testid={`factory-board-gate-${run.id}-${chip.id}`}
              data-tone={chip.tone}
              data-stale={chip.stale || undefined}
            >
              {chip.label}
            </LabelBadge>
          </span>
        );
        if (!chip.detail && !chip.stale) return <span key={chip.id}>{badge}</span>;
        return (
          <Tooltip key={chip.id}>
            <TooltipTrigger asChild>
              <span tabIndex={0}>{badge}</span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              <div className="whitespace-pre-line">
                {chip.detail}
                {chip.stale &&
                  `${chip.detail ? '\n' : ''}${t('factoryBoard.gate.stale', 'For an older commit')}`}
              </div>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </div>
  );
}
