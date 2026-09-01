import { EventDurability } from '@funny/shared/runner-v2/events';
import { describe, expect, test, vi } from 'vitest';

import {
  RunnerEventPublisher,
  runnerEventDurability,
} from '../../services/runner-event-publisher.js';

describe('RunnerEventPublisher', () => {
  test('classifies terminal, durable, and transient events', () => {
    expect(runnerEventDurability({ type: 'agent:result' } as any)).toBe(EventDurability.TERMINAL);
    expect(runnerEventDurability({ type: 'agent:status' } as any)).toBe(EventDurability.DURABLE);
    expect(runnerEventDurability({ type: 'thread:update' } as any)).toBe(EventDurability.TRANSIENT);
  });

  test('publishes stored events and acknowledges contiguous receipts', () => {
    const send = vi.fn(() => true);
    const acknowledge = vi.fn();
    const store = {
      resumeCursors: () => [],
      append: (event: any) => ({
        ...event,
        sequence: 1n,
        occurredAt: '2026-08-31T00:00:00.000Z',
      }),
      pendingScopes: () => [],
      replay: vi.fn(),
      acknowledge,
      close: vi.fn(),
    };
    const publisher = new RunnerEventPublisher({ send }, store as any);

    publisher.publish({
      type: 'agent:status',
      threadId: 'thread-1',
      data: { status: 'running' },
    } as any);
    expect(send).toHaveBeenCalledWith('events', expect.objectContaining({ sequence: '1' }));

    publisher.receiveReceipt({
      scope: { threadId: 'thread-1', executionId: 'execution-1' },
      accepted: { highestContiguousSequence: '1' },
    });
    expect(acknowledge).toHaveBeenCalledWith(
      { threadId: 'thread-1', executionId: 'execution-1' },
      1n,
    );
  });
});
