/**
 * The state chip of a factory board card: a column holds several states (a
 * person's column holds failed, waiting and needs-info runs; the done column
 * merged, stopped and split ones), so the card says which one it is.
 */
import type { TFunction } from 'i18next';

import type { LabelBadgeTone } from '@/components/ui/label-badge';
import type { FactoryRun } from '@/lib/api/factory';
import { factoryRunStateLabel } from '@/lib/factory-run-labels';

import { plainFactoryReason } from './run-dependencies';
import { factoryRunWaitingText } from './run-waiting';

const TONE_OF = {
  requested: 'neutral',
  queued: 'neutral',
  triaging: 'info',
  needs_info: 'warning',
  working: 'info',
  pr_open: 'info',
  waiting_ci: 'info',
  fixing: 'warning',
  reviewing: 'info',
  merging: 'info',
  waiting_human: 'warning',
  merged: 'success',
  no_change: 'neutral',
  done: 'success',
  failed: 'danger',
  stopped: 'neutral',
} satisfies Record<FactoryRun['state'], LabelBadgeTone>;

const TONES: ReadonlyMap<string, LabelBadgeTone> = new Map(Object.entries(TONE_OF));

export interface FactoryRunStateChip {
  label: string;
  tone: LabelBadgeTone;
  /** What the state means for this run (the questions triage asked, why it failed): the chip's tooltip. */
  detail?: string;
}

/** What the card's state chip says; a run the factory split says so instead of "Done". */
export function factoryRunStateChip(
  t: TFunction,
  run: Pick<FactoryRun, 'state' | 'triage'>,
): FactoryRunStateChip {
  if ((run.triage?.splitInto?.length ?? 0) > 0 && run.state === 'done') {
    return { label: t('factory.state.split', 'Split'), tone: 'info' };
  }
  if (run.state === 'needs_info' && run.triage?.decision === 'too_big') {
    return { label: t('factory.state.tooBig', 'Too big'), tone: 'warning' };
  }
  return {
    label: factoryRunStateLabel(t, run.state) ?? run.state,
    tone: TONES.get(run.state) ?? 'neutral',
  };
}

/**
 * Waiting for you is what the "Needs a person" column means: the other states
 * there (failed, needs info, no change) keep their chip to tell them apart.
 */
const SHOWN_BY_COLUMN: ReadonlySet<FactoryRun['state']> = new Set(['waiting_human']);

/** States a thread's status icon already shows. */
const SHOWN_BY_THREAD_ICON: ReadonlySet<FactoryRun['state']> = new Set(['working', 'stopped']);

/** States whose explanation is the state chip's tooltip; a queued run's wait has its own chip. */
const EXPLAINED_BY_STATE: ReadonlySet<FactoryRun['state']> = new Set([
  'needs_info',
  'done',
  'no_change',
  'failed',
]);

const MAX_DETAIL = 600;

/**
 * A stopped run that never started an agent: taken out of the queue, or
 * stopped before its flow's first step. Said so, since the card has nothing else.
 */
function stoppedBeforeStartChip(
  t: TFunction,
  run: Pick<FactoryRun, 'state' | 'threadIds' | 'admittedAt'>,
): FactoryRunStateChip | null {
  if (run.state !== 'stopped' || run.threadIds.length > 0) return null;
  return {
    label: t('factory.state.notStarted', 'Not started'),
    tone: 'neutral',
    detail:
      run.admittedAt === null
        ? t(
            'factory.state.notStartedQueued',
            'Taken out of the queue before it started: no agent ran, no branch or pull request',
          )
        : t(
            'factory.state.notStartedStopped',
            'Stopped before its first step: no agent ran, no branch or pull request',
          ),
  };
}

/**
 * The board card's state chip, or null when the card shows the state without
 * it. A run with no thread has its state dot for its icon.
 * What the state means for this run is the chip's tooltip, not a line of text.
 */
export function factoryBoardStateChip(
  t: TFunction,
  run: Pick<
    FactoryRun,
    'state' | 'triage' | 'waitReason' | 'failureReason' | 'threadIds' | 'admittedAt'
  >,
  hasThread: boolean,
): FactoryRunStateChip | null {
  if (SHOWN_BY_COLUMN.has(run.state)) return null;
  if (hasThread && SHOWN_BY_THREAD_ICON.has(run.state)) return null;
  const notStarted = stoppedBeforeStartChip(t, run);
  if (notStarted) return notStarted;
  const chip = factoryRunStateChip(t, run);
  const why = EXPLAINED_BY_STATE.has(run.state) ? factoryRunWaitingText(t, run) : null;
  if (!why) return chip;
  const detail = plainFactoryReason(why);
  return {
    ...chip,
    detail: detail.length > MAX_DETAIL ? `${detail.slice(0, MAX_DETAIL - 1)}…` : detail,
  };
}
