/**
 * Which board column a flow step belongs to (openspec factory-step-timings,
 * D2): the built-in flows' node ids. A retry's `<node>.before_retry` counts
 * for its node; any other step counts in no column.
 */
import type { FactoryBoardColumnId } from './board-columns';

const STAGE_OF_STEP: ReadonlyMap<string, FactoryBoardColumnId> = new Map([
  ['triage', 'triage'],
  ['implement', 'implementing'],
  ['address', 'implementing'],
  ['pull-request', 'pr'],
  ['regression-proof', 'pr'],
  ['ci', 'pr'],
  ['review', 'review'],
  ['merge', 'merge'],
]);

/** The columns that time is measured in, left to right. */
export const TIMED_COLUMNS: readonly FactoryBoardColumnId[] = [
  'triage',
  'implementing',
  'pr',
  'review',
  'merge',
];

export function stageOfStep(step: string): FactoryBoardColumnId | null {
  return STAGE_OF_STEP.get(step.replace(/\.before_retry$/, '')) ?? null;
}
