/**
 * The run's flow as the board card's strip shows it (openspec
 * factory-pipeline-board, D3): each step's status from `factoryRunSteps`, the
 * review round, and the options an agent step ran with.
 */
import type { FactoryRun, FactoryStepOptionsRecord } from '@funny/shared/contracts/factory';

import { factoryRunSteps, type FactoryStepStatus } from '@/lib/factory-run-labels';

/** The node id of a review step in the built-in flows. */
const REVIEW_STEP = 'review';

export interface FactoryStripStep {
  name: string;
  status: FactoryStepStatus;
  /** On a review step that ran: the round it is on, counting the one in progress. */
  round?: number;
  /** What the step's agent ran with, the last time it ran. */
  options?: FactoryStepOptionsRecord;
}

export function factoryRunStrip(
  run: Pick<
    FactoryRun,
    'state' | 'currentStep' | 'flowSteps' | 'failureReason' | 'reviews' | 'stepOptions'
  >,
): FactoryStripStep[] {
  if (run.flowSteps.length === 0) return [];
  const round = run.reviews.length + (run.state === 'reviewing' ? 1 : 0);
  return factoryRunSteps(run).map((step) => {
    const strip: FactoryStripStep = { ...step };
    if (step.name === REVIEW_STEP && round > 0) strip.round = round;
    const options = run.stepOptions.findLast((record) => record.stepId === step.name);
    if (options) strip.options = options;
    return strip;
  });
}
