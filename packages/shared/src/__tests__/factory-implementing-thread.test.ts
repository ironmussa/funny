/**
 * A run's implementing thread (openspec factory-flow-step-options): a
 * `thread: new` step's own read-only thread is never the one a member opens or
 * follows up on to take the run over (found in the E2E: run #41's thread link
 * pointed at its advisory step).
 */
import { describe, expect, test } from 'bun:test';

import { implementingThreadOf, type FactoryStepOptionsRecord } from '../contracts/factory.js';

const step = (stepId: string, threadId: string, thread: 'continue' | 'new') =>
  ({
    stepId,
    threadId,
    provider: 'claude',
    model: 'opus',
    effort: null,
    permissionMode: thread === 'new' ? 'plan' : 'autoEdit',
    allowedTools: null,
    disallowedTools: null,
    thread,
  }) satisfies FactoryStepOptionsRecord;

describe('implementingThreadOf', () => {
  test('skips a thread: new step that ran last', () => {
    expect(
      implementingThreadOf({
        threadIds: ['impl', 'advise'],
        stepOptions: [step('implement', 'impl', 'continue'), step('advise', 'advise', 'new')],
      }),
    ).toBe('impl');
  });

  test('is the last continued thread after a fix step', () => {
    expect(
      implementingThreadOf({
        threadIds: ['impl', 'advise', 'impl'],
        stepOptions: [
          step('implement', 'impl', 'continue'),
          step('advise', 'advise', 'new'),
          step('ci.before_retry', 'impl', 'continue'),
        ],
      }),
    ).toBe('impl');
  });

  test('runs from before step options keep their last thread', () => {
    expect(implementingThreadOf({ threadIds: ['a', 'b'], stepOptions: [] })).toBe('b');
    expect(implementingThreadOf({ threadIds: [], stepOptions: [] })).toBeUndefined();
  });
});
