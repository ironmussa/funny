import { describe, expect, test } from 'vitest';

import { turnOutcomesFromEvents } from '@/lib/turn-outcomes-from-events';

const event = (id: string, type: string, data: unknown) =>
  ({ id, threadId: 't1', type, data: JSON.stringify(data), createdAt: '' }) as any;

describe('turnOutcomesFromEvents', () => {
  test('maps each turn to how its run ended, last event winning', () => {
    const outcomes = turnOutcomesFromEvents([
      event('e1', 'turn_outcome', { userMessageId: 'u1', status: 'stopped', completedAt: 'a' }),
      event('e2', 'changed_files_summary', { userMessageId: 'u1', files: [] }),
      event('e3', 'turn_outcome', { userMessageId: 'u2', status: 'failed', completedAt: 'b' }),
      event('e4', 'turn_outcome', { userMessageId: 'u2', status: 'completed', completedAt: 'c' }),
    ]);

    expect(outcomes.get('u1')?.status).toBe('stopped');
    expect(outcomes.get('u2')).toEqual({
      userMessageId: 'u2',
      status: 'completed',
      completedAt: 'c',
    });
    expect(outcomes.size).toBe(2);
  });

  test('ignores malformed payloads', () => {
    expect(
      turnOutcomesFromEvents([{ ...event('e1', 'turn_outcome', {}), data: '{bad' }]).size,
    ).toBe(0);
  });
});
