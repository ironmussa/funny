import type { TaskProgress, TaskStep } from '@funny/shared/task-progress';

export interface TaskProgressSummary {
  errors: number;
  warnings: number;
  stepsDone: number;
  stepsRunning: number;
  /** 0–100: each step weighs the same; a running step counts its sub-units. */
  percent: number;
}

const isFinished = (step: TaskStep) => step.status === 'passed' || step.status === 'failed';

/** How much of a step is done, 0–1. */
function stepShare(step: TaskStep): number {
  if (isFinished(step)) return 1;
  if (step.status !== 'running' || !step.unitsTotal) return 0;
  return Math.min(step.unitsDone ?? 0, step.unitsTotal) / step.unitsTotal;
}

/** Totals and progress of a task run. */
export function summarizeTaskProgress(progress: TaskProgress): TaskProgressSummary {
  const { steps } = progress;
  const done = steps.reduce((sum, step) => sum + stepShare(step), 0);
  return {
    errors: steps.reduce((sum, step) => sum + step.errors, 0),
    warnings: steps.reduce((sum, step) => sum + step.warnings, 0),
    stepsDone: steps.filter(isFinished).length,
    stepsRunning: steps.filter((step) => step.status === 'running').length,
    percent: steps.length === 0 ? 0 : (done / steps.length) * 100,
  };
}
