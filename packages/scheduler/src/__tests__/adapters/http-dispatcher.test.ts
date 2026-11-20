/**
 * Unit tests for HttpDispatcher — dispatch + terminal-event handoff.
 */

import { describe, expect, test } from 'bun:test';

import { HttpSchedulerClient } from '../../adapters/http-client.js';
import { HttpDispatcher } from '../../adapters/http-dispatcher.js';
import { HttpEventStream, type EventStreamEvent } from '../../adapters/http-event-stream.js';
import type { SchedulerLogger } from '../../service.js';
import { buildThread, fetchDouble } from '../test-helpers.js';

/** What the server's `/dispatch` and `/cancel` answer; `undefined` is an empty 204. */
interface DispatchReplyBody {
  ok: boolean;
  pipelineRunId?: string;
  error?: { message?: string };
}
type DispatchReply = DispatchReplyBody | undefined;

/**
 * A real HttpEventStream that is never started: `emit` hands an event to the
 * stream's own dispatch, so it reaches current subscribers only.
 */
function fakeStream() {
  const stream = new HttpEventStream({ client: schedulerClient(async () => undefined) });
  return {
    stream,
    emit(threadId: string, payload: EventStreamEvent['payload']) {
      const event: EventStreamEvent = { seq: 1, kind: 'agent_terminal', threadId, ts: 1, payload };
      stream['dispatch'](event);
    },
    subscriberCount: (threadId: string) => stream['handlers'].get(threadId)?.size ?? 0,
  };
}

/** A real client whose fetch answers every POST with `post(path)`'s JSON (path below the system prefix). */
function schedulerClient(post: (path: string) => Promise<DispatchReply>): HttpSchedulerClient {
  return new HttpSchedulerClient({
    baseUrl: 'http://srv',
    authSecret: 's',
    fetch: fetchDouble(async (input) => {
      const url = new URL(input instanceof Request ? input.url : input);
      const result = await post(url.pathname.replace('/api/scheduler/system', ''));
      return new Response(result === undefined ? null : JSON.stringify(result), {
        status: result === undefined ? 204 : 200,
      });
    }),
  });
}

const log: SchedulerLogger = { info: () => {}, warn: () => {}, error: () => {} };
const thread = buildThread({ id: 't1', userId: 'u1', title: 'do it' });

function dispatcher(
  events: ReturnType<typeof fakeStream>,
  post: (path: string) => Promise<DispatchReply>,
) {
  return new HttpDispatcher({
    client: schedulerClient(post),
    eventStream: events.stream,
    log,
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
