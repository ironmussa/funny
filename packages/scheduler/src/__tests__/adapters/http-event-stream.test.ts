/**
 * Unit tests for HttpEventStream — the long-poll consumer.
 */

import { describe, expect, test } from 'bun:test';

import { HttpSchedulerClient } from '../../adapters/http-client.js';
import { HttpEventStream, type EventStreamEvent } from '../../adapters/http-event-stream.js';

interface PollResponse {
  events: EventStreamEvent[];
  nextSeq: number;
  epoch?: string;
}

function makeStream(responses: PollResponse[], requests: URL[] = []): HttpEventStream {
  let i = 0;
  const fakeFetch = (async (input: string | URL | Request) => {
    requests.push(new URL(typeof input === 'string' ? input : input.toString()));
    const next = responses[i++] ?? { events: [], nextSeq: 0 };
    return new Response(JSON.stringify(next), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
  const client = new HttpSchedulerClient({
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

  test('resets the cursor when the server epoch changes (server restarted)', async () => {
    const ev = (seq: number, threadId: string): EventStreamEvent => ({
      seq,
      kind: 'agent_terminal',
      threadId,
      ts: 0,
      payload: {},
    });
    const requests: URL[] = [];
    const stream = makeStream(
      [
        { events: [ev(500, 't1')], nextSeq: 500, epoch: 'boot-a' },
        // The restarted server answers from seq 0 because the epoch differs.
        { events: [ev(1, 't1'), ev(2, 't1')], nextSeq: 2, epoch: 'boot-b' },
      ],
      requests,
    );
    const received: number[] = [];
    stream.subscribe('t1', (e) => received.push(e.seq));

    stream.start();
    for (let i = 0; i < 100 && requests.length < 3; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await stream.stop();

    expect(requests.length).toBeGreaterThanOrEqual(3);
    expect(received).toEqual([500, 1, 2]);
    expect(requests[1].searchParams.get('since')).toBe('500');
    expect(requests[1].searchParams.get('epoch')).toBe('boot-a');
    expect(requests[2].searchParams.get('since')).toBe('2');
    expect(requests[2].searchParams.get('epoch')).toBe('boot-b');
  });
});

test('stop interrupts reconnect backoff instead of waiting for the next poll', async () => {
  const attempted = Promise.withResolvers<void>();
  const client = new HttpSchedulerClient({
    baseUrl: 'http://srv',
    authSecret: 'test-secret',
    fetch: (async () => {
      attempted.resolve();
      throw new Error('offline');
    }) as unknown as typeof fetch,
  });
  const stream = new HttpEventStream({ client, errorBackoffMs: 60_000 });
  stream.start();
  await attempted.promise;
  await new Promise((resolve) => setTimeout(resolve, 0));
  await stream.stop();
}, 1000);
