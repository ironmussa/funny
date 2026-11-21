import { describe, expect, test } from 'bun:test';

import { ACTIVITY_STATUS_WRITTEN_FROM, nextActivityStatus } from '../activity-machine.js';

describe('activity machine', () => {
  test('legal transitions', () => {
    expect(nextActivityStatus('running', 'running')).toBe(true);
    expect(nextActivityStatus('running', 'succeeded')).toBe(true);
    expect(nextActivityStatus('running', 'failed')).toBe(true);
    expect(nextActivityStatus('running', 'interrupted')).toBe(true);
    expect(nextActivityStatus('interrupted', 'succeeded')).toBe(true);
    expect(nextActivityStatus('interrupted', 'failed')).toBe(true);
  });

  test('final statuses cannot be left', () => {
    expect(nextActivityStatus('succeeded', 'failed')).toBe(false);
    expect(nextActivityStatus('failed', 'succeeded')).toBe(false);
    expect(nextActivityStatus('succeeded', 'running')).toBe(false);
    expect(nextActivityStatus('failed', 'interrupted')).toBe(false);
  });

  test('an interrupted activity does not run again', () => {
    expect(nextActivityStatus('interrupted', 'running')).toBe(false);
    expect(nextActivityStatus('interrupted', 'interrupted')).toBe(false);
  });

  test('guard table', () => {
    expect([...ACTIVITY_STATUS_WRITTEN_FROM.succeeded].sort()).toEqual(['interrupted', 'running']);
    expect([...ACTIVITY_STATUS_WRITTEN_FROM.interrupted]).toEqual(['running']);
    expect([...ACTIVITY_STATUS_WRITTEN_FROM.running]).toEqual(['running']);
  });
});
