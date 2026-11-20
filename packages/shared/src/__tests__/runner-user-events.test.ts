import { describe, expect, test } from 'bun:test';

import { isRunnerUserEventType } from '../runner-protocol.js';

describe('isRunnerUserEventType', () => {
  test('allows browser-session events and clone progress', () => {
    expect(isRunnerUserEventType('browser-session:frame')).toBe(true);
    expect(isRunnerUserEventType('clone:progress')).toBe(true);
  });

  test('refuses thread events, which must be scoped to a thread', () => {
    expect(isRunnerUserEventType('agent:message')).toBe(false);
    expect(isRunnerUserEventType('thread:updated')).toBe(false);
    expect(isRunnerUserEventType('clone:progressX')).toBe(false);
  });
});
