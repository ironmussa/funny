import type { TaskProgress, TaskStep } from '@funny/shared/task-progress';
import { describe, expect, test } from 'vitest';

import { summarizeTaskProgress } from '@/lib/task-progress-summary';

const step = (fields: Partial<TaskStep> & { name: string }): TaskStep => ({
  id: fields.name,
  status: 'queued',
  errors: 0,
  warnings: 0,
  tail: [],
  ...fields,
});

const task = (steps: TaskStep[]): TaskProgress => ({
  version: 1,
  title: 'lint',
  status: 'running',
  startedAt: 0,
  updatedAt: 0,
  steps,
  issues: [],
});

describe('summarizeTaskProgress', () => {
  test('adds up issues and finished / running steps', () => {
    expect(
      summarizeTaskProgress(
        task([
          step({ name: 'a', status: 'passed', warnings: 3 }),
          step({ name: 'b', status: 'failed', errors: 2, warnings: 1 }),
          step({ name: 'c', status: 'running' }),
          step({ name: 'd' }),
        ]),
      ),
    ).toMatchObject({ errors: 2, warnings: 4, stepsDone: 2, stepsRunning: 1, percent: 50 });
  });

  test('a running step with sub-units counts the share it has done', () => {
    // a done (1) + b at 6/15 (0.4) + c queued (0) → 1.4 of 3.
    const summary = summarizeTaskProgress(
      task([
        step({ name: 'a', status: 'passed' }),
        step({ name: 'b', status: 'running', unitsDone: 6, unitsTotal: 15 }),
        step({ name: 'c' }),
      ]),
    );
    expect(summary.percent).toBeCloseTo((1.4 / 3) * 100);
  });

  test('an empty task is at 0%', () => {
    expect(summarizeTaskProgress(task([])).percent).toBe(0);
  });
});
