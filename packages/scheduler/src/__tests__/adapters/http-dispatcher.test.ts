/**
 * Unit tests for HttpDispatcher — dispatch + terminal-event handoff.
 */

import { describe, expect, test } from 'bun:test';

import type { Thread } from '@funny/shared';

import type { HttpSchedulerClient } from '../../adapters/http-client.js';
import { HttpDispatcher } from '../../adapters/http-dispatcher.js';
import type { EventStreamEvent, HttpEventStream } from '../../adapters/http-event-stream.js';

type Handler = (event: EventStreamEvent) => void;

/** In-memory stand-in for HttpEventStream: `emit` reaches current subscribers only. */
function fakeStream() {
  const handlers = new Map<string, Set<Handler>>();
  return {
    stream: {
      subscribe(threadId: string, handler: Handler) {
        const set = handlers.get(threadId) ?? new Set<Handler>();
        set.add(handler);
        handlers.set(threadId, set);
        return () => set.delete(handler);
      },
    } as unknown as HttpEventStream,
    emit(threadId: string, payload: Record<string, unknown>) {
      const event: EventStreamEvent = { seq: 1, kind: 'agent_terminal', threadId, ts: 1, payload };
      for (const handler of handlers.get(threadId) ?? []) handler(event);
    },
    subscriberCount: (threadId: string) => handlers.get(threadId)?.size ?? 0,
  };
}

const log = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const thread = { id: 't1', userId: 'u1', title: 'do it' } as unknown as Thread;

function dispatcher(
  events: ReturnType<typeof fakeStream>,
  post: (path: string) => Promise<unknown>,
) {
  return new HttpDispatcher({
    client: { post } as unknown as HttpSchedulerClient,
    eventStream: events.stream,
    log: log as never,
  });
}

describe('HttpDispatcher', () => {
  test('a terminal event published before /dispatch answers still settles the run', async () => {
    const events = fakeStream();
    const d = dispatcher(events, async () => {
      // The run fails at once: its terminal event arrives before the response.
      events.emit('t1', { kind: 'failed', error: 'boom' });
      return { ok: true, pipelineRunId: 'run-1' };
    });

    const result = await d.dispatch(thread);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await result.handle.finished).toEqual({ kind: 'failed', error: 'boom' });
    expect(events.subscriberCount('t1')).toBe(0);
  });

  test('a terminal event after dispatch settles the run', async () => {
    const events = fakeStream();
    const d = dispatcher(events, async () => ({ ok: true, pipelineRunId: 'run-1' }));

    const result = await d.dispatch(thread);
    if (!result.ok) throw new Error('dispatch failed');
    events.emit('t1', { kind: 'completed' });
    expect(await result.handle.finished).toEqual({ kind: 'completed' });
  });

  test('a failed dispatch leaves no subscription behind', async () => {
    const events = fakeStream();
    const refused = dispatcher(events, async () => ({ ok: false, error: { message: 'no' } }));
    expect((await refused.dispatch(thread)).ok).toBe(false);
    const thrown = dispatcher(events, async () => {
      throw new Error('down');
    });
    expect((await thrown.dispatch(thread)).ok).toBe(false);
    expect(events.subscriberCount('t1')).toBe(0);
  });
});
