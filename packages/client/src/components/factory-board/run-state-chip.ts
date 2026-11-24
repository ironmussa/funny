/**
 * The state chip of a factory board card: a column holds several states (a
 * person's column holds failed, waiting and needs-info runs; the done column
 * merged, stopped and split ones), so the card says which one it is.
 */
import type { TFunction } from 'i18next';

import type { LabelBadgeTone } from '@/components/ui/label-badge';
import type { FactoryRun } from '@/lib/api/factory';
import { factoryRunStateLabel } from '@/lib/factory-run-labels';

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
