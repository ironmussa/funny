import type { WSEvent } from '@funny/shared';
import { EventDurability } from '@funny/shared/runner-v2/events';
import { describe, expect, test, vi } from 'vitest';

import { GrpcEventReplayStore } from '../../services/grpc-event-replay-store.js';
import {
  RunnerEventPublisher,
  runnerEventDurability,
} from '../../services/runner-event-publisher.js';

describe('RunnerEventPublisher', () => {
  test('classifies terminal, durable, and transient events', () => {
    expect(runnerEventDurability({ type: 'agent:result', threadId: 't', data: {} })).toBe(
      EventDurability.TERMINAL,
    );
    expect(
      runnerEventDurability({ type: 'agent:status', threadId: 't', data: { status: 'running' } }),
    ).toBe(EventDurability.DURABLE);
    expect(runnerEventDurability({ type: 'thread:updated', threadId: 't', data: {} })).toBe(
      EventDurability.TRANSIENT,
    );
  });

  test('publishes stored events and acknowledges contiguous receipts', () => {
    const send = vi.fn(() => true);
    const store = new GrpcEventReplayStore(':memory:');
    vi.spyOn(store, 'append').mockImplementation((event) => ({
      ...event,
      sequence: 1n,
      occurredAt: '2026-08-31T00:00:00.000Z',
    }));
    const acknowledge = vi.spyOn(store, 'acknowledge').mockReturnValue(true);
    const publisher = new RunnerEventPublisher({ send }, store);

    publisher.publish({
      type: 'agent:status',
      threadId: 'thread-1',
      data: { status: 'running' },
    });
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

  test('unscoped browser-session events go out as user events once the server enables them', () => {
    const send = vi.fn(() => true);
    const store = new GrpcEventReplayStore(':memory:');
    const append = vi.spyOn(store, 'append');
    const publisher = new RunnerEventPublisher({ send }, store);
    const frame = {
      type: 'browser-session:frame',
      threadId: '',
      data: { sessionId: 'thread:t1', data: 'abc', timestamp: 1 },
    } satisfies WSEvent;

    publisher.publish(frame);
    expect(send).not.toHaveBeenCalled();

    publisher.setUserEventsEnabled(true);
    publisher.publish(frame);
    publisher.publish({ type: 'thread:updated', threadId: '', data: {} });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith('events', {
      userEvent: {
        eventType: 'browser-session:frame',
        data: { sessionId: 'thread:t1', data: 'abc', timestamp: 1 },
      },
    });
    // Never stored for replay.
    expect(append).not.toHaveBeenCalled();
  });
});
