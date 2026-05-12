/**
 * Unit tests for HttpEventStream — the long-poll consumer.
 */

import { describe, expect, test } from 'bun:test';

import { HttpOrchestratorClient } from '../../adapters/http-client.js';
import { HttpEventStream, type EventStreamEvent } from '../../adapters/http-event-stream.js';

interface PollResponse {
  events: EventStreamEvent[];
  nextSeq: number;
}

function makeStream(responses: PollResponse[]): HttpEventStream {
  let i = 0;
  const fakeFetch: typeof fetch = async () => {
    const next = responses[i++] ?? { events: [], nextSeq: 0 };
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = new HttpOrchestratorClient({
    baseUrl: 'http://srv',
    authSecret: 's',
    fetch: fakeFetch,
  });
  return new HttpEventStream({
    client,
    longPollTimeoutMs: 10,
    errorBackoffMs: 5,
  });
}

describe('HttpEventStream', () => {
  test('dispatches matching events to subscribers and advances cursor', async () => {
    const events: EventStreamEvent[] = [
      { seq: 1, kind: 'agent_terminal', threadId: 't1', ts: 1_000, payload: { kind: 'completed' } },
      {
        seq: 2,
        kind: 'agent_terminal',
        threadId: 't2',
        ts: 1_100,
        payload: { kind: 'failed', error: 'boom' },
      },
    ];
    const stream = makeStream([{ events, nextSeq: 2 }]);

    const received1: EventStreamEvent[] = [];
    const received2: EventStreamEvent[] = [];
    stream.subscribe('t1', (e) => received1.push(e));
    stream.subscribe('t2', (e) => received2.push(e));

    stream.start();
    await new Promise((r) => setTimeout(r, 50));
    await stream.stop();

    expect(received1).toHaveLength(1);
    expect(received1[0].seq).toBe(1);
    expect(received2).toHaveLength(1);
    expect(received2[0].payload).toEqual({ kind: 'failed', error: 'boom' });
    expect(stream.currentCursor()).toBe(2);
  });

  test('unsubscribe removes handler', async () => {
    const events: EventStreamEvent[] = [
      { seq: 1, kind: 'agent_terminal', threadId: 't1', ts: 0, payload: {} },
    ];
    const stream = makeStream([{ events, nextSeq: 1 }]);

    const received: EventStreamEvent[] = [];
    const unsub = stream.subscribe('t1', (e) => received.push(e));
    unsub();

    stream.start();
    await new Promise((r) => setTimeout(r, 50));
    await stream.stop();

    expect(received).toHaveLength(0);
  });

  test('cursor advances even when no events arrive', async () => {
    const stream = makeStream([{ events: [], nextSeq: 5 }]);
    stream.start();
    await new Promise((r) => setTimeout(r, 50));
    await stream.stop();
    expect(stream.currentCursor()).toBe(5);
  });
});
