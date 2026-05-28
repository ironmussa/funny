import { describe, expect, test } from 'bun:test';

import {
  BROWSER_PTY_FORWARD_EVENTS,
  parseObjectPayload,
  parseRunnerAgentEvent,
  runnerAgentEventSchema,
} from '../../src/socket-events.ts';

describe('socket-events', () => {
  test('parseObjectPayload accepts objects and nullish', () => {
    expect(parseObjectPayload(null)).toEqual({});
    expect(parseObjectPayload({ projectId: 'p1' })).toEqual({ projectId: 'p1' });
    expect(parseObjectPayload([])).toBeNull();
    expect(parseObjectPayload('x')).toBeNull();
  });

  test('parseRunnerAgentEvent validates userId', () => {
    expect(parseRunnerAgentEvent({ userId: 'u1', event: { type: 'agent:status' } })).toEqual({
      userId: 'u1',
      event: { type: 'agent:status' },
    });
    expect(parseRunnerAgentEvent({ event: {} })).toBeNull();
  });

  test('BROWSER_PTY_FORWARD_EVENTS includes pty:signal', () => {
    expect(BROWSER_PTY_FORWARD_EVENTS).toContain('pty:signal');
  });

  test('runnerAgentEventSchema rejects arrays', () => {
    expect(runnerAgentEventSchema.safeParse([]).success).toBe(false);
  });
});
