/**
 * The status glyph of a factory board card: a dot in the run's state color
 * (the thread's own pin while its agent or the factory is still working on
 * it), none once the run is finished. It turns into a checkbox on hover, or on every card once one is
 * selected, so several runs can be picked for a bulk action.
 */
import type { Thread } from '@funny/shared';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { ThreadStatusPin } from '@/components/thread/ThreadStatusPin';
import { Checkbox } from '@/components/ui/checkbox';
import type { LabelBadgeTone } from '@/components/ui/label-badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { FactoryQueueRun } from '@/lib/api/factory';
import { ENDED_FACTORY_STATES } from '@/lib/factory-run-labels';
import { cn } from '@/lib/utils';

import { factoryBoardColumn } from './board-columns';
import { factoryRunStateChip } from './run-state-chip';

const DOT_CLASS: Record<LabelBadgeTone, string> = {
  success: 'bg-status-success',
  danger: 'bg-status-error',
  warning: 'bg-status-warning',
  info: 'bg-status-info',
  neutral: 'bg-muted-foreground',
};

/** States where the run waits on a person: its state says more than the thread's. */
const WAITS_ON_PERSON: ReadonlySet<FactoryQueueRun['state']> = new Set([
  'waiting_human',
  'needs_info',
  'failed',
]);

/** Whether the card shows the thread's live pin (spinner while working) rather than the run's dot. */
function showsThreadPin(run: FactoryQueueRun, thread: Thread | undefined): thread is Thread {
  return Boolean(thread) && !ENDED_FACTORY_STATES.has(run.state) && !WAITS_ON_PERSON.has(run.state);
}

/** A dot in the run's state color, its state on hover. */
function FactoryRunStateDot({ run }: { run: FactoryQueueRun }) {
  const { t } = useTranslation();
  const state = factoryRunStateChip(t, run);
  const color = DOT_CLASS[state.tone];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex size-3.5 items-center justify-center">
          <span
            className={cn('block size-2 rounded-full', color)}
            data-testid={`factory-board-dot-${run.id}`}
            data-state={run.state}
          />
        </span>
      </TooltipTrigger>
      <TooltipContent side="top">{state.label}</TooltipContent>
    </Tooltip>
  );
}

export interface FactoryRunSelectionProps {
  /** Whether this card is selected. */
  selected?: boolean;
  /** Whether any card is selected: every card then shows its checkbox. */
  selecting?: boolean;
  /** Selects or unselects the run; absent, the card has no checkbox. */
  onToggleSelected?: (runId: string) => void;
}

/** The card's status slot: the glyph, swapped for a checkbox on hover or while selecting. */
export function FactoryRunStatus({
  run,
  thread,
  selected = false,
  selecting = false,
  onToggleSelected,
}: { run: FactoryQueueRun; thread: Thread | undefined } & FactoryRunSelectionProps) {
  const { t } = useTranslation();
  // A finished run needs no dot: its chip (Merged, Stopped) already says how it ended.
  const finished = factoryBoardColumn(run.state) === 'done';
  const glyph: ReactNode = finished ? null : showsThreadPin(run, thread) ? (
    <ThreadStatusPin thread={thread} hoverGroup="card" />
  ) : (
    <FactoryRunStateDot run={run} />
  );
  if (!onToggleSelected) return glyph;
  const showBox = selected || selecting;
  return (
    <span
      className="relative inline-flex size-3.5 shrink-0"
      // Nothing to show but the hover checkbox: the card keeps no blank slot.
      data-collapsed={finished && !showBox ? '' : undefined}
    >
      <span
        className={cn(
          'absolute inset-0 flex items-center justify-center',
          showBox ? 'hidden' : 'group-hover/card:hidden',
        )}
      >
        {glyph}
      </span>
      <span
        className={cn(
          'absolute inset-0 items-center justify-center',
          showBox ? 'flex' : 'hidden group-hover/card:flex',
        )}
      >
        <Checkbox
          checked={selected}
          aria-label={t('factoryBoard.selection.select', 'Select run')}
          data-testid={`factory-board-select-${run.id}`}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onCheckedChange={() => onToggleSelected(run.id)}
        />
      </span>
    </span>
  );
}
