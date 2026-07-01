import { describe, expect, test } from 'vitest';

import { transitionThreadLifecycle } from '../../services/thread-lifecycle-machine.js';

describe('thread-lifecycle-machine', () => {
  test.each(['backlog', 'planning', 'review'])(
    'AGENT_STARTED moves running %s threads to in_progress',
    (stage) => {
      expect(
        transitionThreadLifecycle({ status: 'running', stage }, { type: 'AGENT_STARTED' }),
      ).toEqual({
        updates: { stage: 'in_progress' },
        clientStatus: { status: 'running', stage: 'in_progress' },
      });
    },
  );

  test('AGENT_STARTED is a no-op for completed review threads', () => {
    expect(
      transitionThreadLifecycle(
        { status: 'completed', stage: 'review' },
        { type: 'AGENT_STARTED' },
      ),
    ).toBeNull();
  });

  test('AGENT_STARTED is a no-op for already in-progress threads', () => {
    expect(
      transitionThreadLifecycle(
        { status: 'running', stage: 'in_progress' },
        { type: 'AGENT_STARTED' },
      ),
    ).toBeNull();
  });
});
