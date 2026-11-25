/**
 * The chips a run's gates and wait give its board card (openspec
 * factory-pipeline-board): why it waits or what stopped it, then the gates.
 */
import { useTranslation } from 'react-i18next';

import type { LabelBadgeTone } from '@/components/ui/label-badge';
import type { FactoryRun } from '@/lib/api/factory';

import { FactoryBoardChip } from './FactoryBoardChip';
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
        const staleNote = chip.stale ? t('factoryBoard.gate.stale', 'For an older commit') : '';
        const detail = [chip.detail, staleNote].filter(Boolean).join('\n');
        return (
          <FactoryBoardChip
            key={chip.id}
            label={chip.label}
            tone={chip.stale ? 'neutral' : TONE[chip.tone]}
            detail={detail || undefined}
            faded={chip.stale}
            testId={`factory-board-gate-${run.id}-${chip.id}`}
            data={{ 'data-tone': chip.tone, 'data-stale': chip.stale ? 'true' : undefined }}
          />
        );
      })}
    </div>
  );
}
