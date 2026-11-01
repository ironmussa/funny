import { describe, expect, test } from 'vitest';

import { sandboxSetupSteps } from '@/hooks/use-sandbox-setup-steps';

const statuses = (steps: ReturnType<typeof sandboxSetupSteps>) => steps.map((s) => s.status);

describe('sandboxSetupSteps', () => {
  test('no sandbox row yet: no steps (the caller shows its waiting state)', () => {
    expect(sandboxSetupSteps(null)).toEqual([]);
  });

  test('marks earlier phases done and the current one running', () => {
    expect(statuses(sandboxSetupSteps({ state: 'connecting', error: null }))).toEqual([
      'completed',
      'completed',
      'running',
      'pending',
      'pending',
    ]);
    expect(statuses(sandboxSetupSteps({ state: 'bootstrapping', error: null }))[3]).toBe('running');
  });

  test('a running sandbox is starting the agent', () => {
    expect(statuses(sandboxSetupSteps({ state: 'running', error: null }))).toEqual([
      'completed',
      'completed',
      'completed',
      'completed',
      'running',
    ]);
  });

  test('a failed sandbox shows the error', () => {
    const steps = sandboxSetupSteps({ state: 'failed', error: 'clone failed' });
    expect(steps[0]).toMatchObject({ status: 'failed', error: 'clone failed' });
  });
});
