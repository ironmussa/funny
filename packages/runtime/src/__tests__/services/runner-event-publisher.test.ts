import { describe, expect, test, vi } from 'bun:test';

import type { WSEvent } from '@funny/shared';
import { EventDurability } from '@funny/shared/runner-v2/events';

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

  describe('a backlog after a reconnect', () => {
    const PERMISSION_DENIED = 3;

    /** A store with one unacknowledged event in each of `count` executions. */
    function backlog(count: number) {
      const store = new GrpcEventReplayStore(':memory:');
      for (let index = 0; index < count; index += 1) {
        store.append({
          scope: {
            threadId: `thread-${index}`,
            executionId: `execution-${String(index).padStart(4, '0')}`,
          },
          eventType: 'git:status',
          data: {},
          durability: EventDurability.TRANSIENT,
          occurredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
        });
      }
      return store;
    }

    function sentScopes(send: ReturnType<typeof vi.fn>) {
      return send.mock.calls.map(
        ([, message]) => message.scope as { threadId: string; executionId: string },
      );
    }

    test('drops the events the server refuses for good, and keeps a retryable failure', () => {
      const send = vi.fn(() => true);
      const store = backlog(2);
      const publisher = new RunnerEventPublisher({ send }, store);
      publisher.activated();
      const [deleted, retried] = sentScopes(send);

      publisher.receiveReceipt({
        scope: deleted,
        failure: {
          code: PERMISSION_DENIED,
          message: 'event scope is not authorized',
          retryable: false,
        },
      });
      publisher.receiveReceipt({
        scope: retried,
        failure: { code: 9, message: 'runner session is not active', retryable: true },
      });

      expect(store.pendingScopes().map((scope) => scope.executionId)).toEqual([
        retried.executionId,
      ]);
    });

    test('sends the next executions when the server has answered the first batch', () => {
      const send = vi.fn(() => true);
      const store = backlog(130);
      const publisher = new RunnerEventPublisher({ send }, store);

      publisher.activated();
      expect(send).toHaveBeenCalledTimes(100);

      const firstBatch = sentScopes(send);
      for (const scope of firstBatch.slice(0, 99)) {
        publisher.receiveReceipt({ scope, failure: { code: PERMISSION_DENIED, retryable: false } });
      }
      expect(send).toHaveBeenCalledTimes(100);
      publisher.receiveReceipt({
        scope: firstBatch[99],
        accepted: { highestContiguousSequence: '1' },
      });

      expect(send).toHaveBeenCalledTimes(130);
      expect(new Set(sentScopes(send).map((scope) => scope.executionId)).size).toBe(130);
      expect(store.pendingScopes(200)).toHaveLength(30);
    });

    test('an execution is replayed once per session, and again after a reconnect', () => {
      const send = vi.fn(() => true);
      const publisher = new RunnerEventPublisher({ send }, backlog(1));

      publisher.activated();
      const [scope] = sentScopes(send);
      // Refused for now, but the events stay: nothing else to send in this session.
      publisher.receiveReceipt({ scope, failure: { code: 13, retryable: false } });
      expect(send).toHaveBeenCalledTimes(1);

      publisher.activated();
      expect(send).toHaveBeenCalledTimes(2);
    });
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

  // Regression: clone progress went out thread-scoped as `clone:<id>`, which
  // the server refused, so the clone view never showed progress or finished.
  test('clone progress goes out as a user event, not a thread event', () => {
    const send = vi.fn(() => true);
    const store = new GrpcEventReplayStore(':memory:');
    const append = vi.spyOn(store, 'append');
    const publisher = new RunnerEventPublisher({ send }, store);
    publisher.setUserEventsEnabled(true);

    publisher.publish({
      type: 'clone:progress',
      threadId: '',
      data: { cloneId: 'c-1', phase: 'Clone complete', status: 'done', projectId: 'p-1' },
    });

    expect(send).toHaveBeenCalledWith('events', {
      userEvent: {
        eventType: 'clone:progress',
        data: { cloneId: 'c-1', phase: 'Clone complete', status: 'done', projectId: 'p-1' },
      },
    });
    expect(append).not.toHaveBeenCalled();
  });
});
