/**
 * Unit tests for SchedulerEventBuffer.
 *
 * Covers:
 *   - sequential publish assigns monotonic seq
 *   - getSince filters correctly
 *   - waitForEvents resolves immediately when events exist
 *   - waitForEvents blocks then resolves on publish
 *   - waitForEvents resolves on timeout with empty events
 *   - capacity trims oldest events
 */

import { describe, test, expect } from 'bun:test';

import { createSchedulerEventBuffer } from '../../services/scheduler-event-buffer.js';

describe('SchedulerEventBuffer', () => {
  test('publish assigns monotonic seq starting at 1', () => {
    const buf = createSchedulerEventBuffer();
    const a = buf.publish({
      kind: 'agent_terminal',
      threadId: 't1',
      payload: { kind: 'completed' },
    });
    const b = buf.publish({ kind: 'agent_terminal', threadId: 't2', payload: { kind: 'failed' } });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
  });

  test('getSince returns only events with seq > since', () => {
    const buf = createSchedulerEventBuffer();
    buf.publish({ kind: 'agent_terminal', threadId: 't1', payload: {} });
    buf.publish({ kind: 'agent_terminal', threadId: 't2', payload: {} });
    buf.publish({ kind: 'thread_stage', threadId: 't3', payload: {} });

    const r1 = buf.getSince(0);
    expect(r1.events.map((e) => e.seq)).toEqual([1, 2, 3]);
    expect(r1.nextSeq).toBe(3);

    const r2 = buf.getSince(2);
    expect(r2.events.map((e) => e.seq)).toEqual([3]);
    expect(r2.nextSeq).toBe(3);

    const r3 = buf.getSince(3);
    expect(r3.events).toEqual([]);
  });

  test('waitForEvents resolves immediately when newer events exist', async () => {
    const buf = createSchedulerEventBuffer();
    buf.publish({ kind: 'agent_terminal', threadId: 't1', payload: {} });
    const result = await buf.waitForEvents(0, 5_000);
    expect(result.events).toHaveLength(1);
    expect(result.nextSeq).toBe(1);
  });

  test('waitForEvents blocks then resolves on publish', async () => {
    const buf = createSchedulerEventBuffer();
    const promise = buf.waitForEvents(0, 5_000);
    setTimeout(() => {
      buf.publish({ kind: 'agent_terminal', threadId: 't1', payload: { kind: 'completed' } });
    }, 20);
    const result = await promise;
    expect(result.events).toHaveLength(1);
    expect(result.events[0].threadId).toBe('t1');
  });

  test('waitForEvents resolves with empty events on timeout', async () => {
    const buf = createSchedulerEventBuffer();
    const start = Date.now();
    const result = await buf.waitForEvents(0, 60);
    const elapsed = Date.now() - start;
    expect(result.events).toEqual([]);
    expect(result.nextSeq).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  test('capacity trims oldest events but seq stays monotonic', () => {
    const buf = createSchedulerEventBuffer({ capacity: 3 });
    for (let i = 0; i < 5; i++) {
      buf.publish({ kind: 'agent_terminal', threadId: `t${i}`, payload: {} });
    }
    // Buffer kept last 3; nextSeq still reflects all 5 published.
    const result = buf.getSince(0);
    expect(result.events).toHaveLength(3);
    expect(result.events[0].seq).toBe(3);
    expect(result.events[2].seq).toBe(5);
    expect(result.nextSeq).toBe(5);
  });

  test('multiple concurrent waiters all wake on a single publish', async () => {
    const buf = createSchedulerEventBuffer();
    const w1 = buf.waitForEvents(0, 5_000);
    const w2 = buf.waitForEvents(0, 5_000);
    const w3 = buf.waitForEvents(0, 5_000);
    setTimeout(() => {
      buf.publish({ kind: 'agent_terminal', threadId: 't1', payload: {} });
    }, 10);
    const [r1, r2, r3] = await Promise.all([w1, w2, w3]);
    expect(r1.events).toHaveLength(1);
    expect(r2.events).toHaveLength(1);
    expect(r3.events).toHaveLength(1);
  });

  test('each buffer has its own epoch, returned with every poll', async () => {
    const a = createSchedulerEventBuffer();
    const b = createSchedulerEventBuffer();
    expect(a.epoch).not.toBe(b.epoch);
    expect(a.getSince(0).epoch).toBe(a.epoch);
    expect((await a.waitForEvents(0, 0)).epoch).toBe(a.epoch);
  });

  test('a cursor from another epoch reads from the start (server restarted)', async () => {
    // Before the restart the consumer had reached seq 500.
    const restarted = createSchedulerEventBuffer();
    restarted.publish({ kind: 'agent_terminal', threadId: 't1', payload: {} });
    restarted.publish({ kind: 'agent_terminal', threadId: 't2', payload: {} });

    const result = await restarted.waitForEvents(500, 0, 'old-epoch');
    expect(result.events.map((e) => e.seq)).toEqual([1, 2]);
    expect(result.epoch).toBe(restarted.epoch);
  });

  test('a long-poll from another epoch wakes on the first publish', async () => {
    const restarted = createSchedulerEventBuffer();
    const pending = restarted.waitForEvents(500, 5_000, 'old-epoch');
    setTimeout(
      () => restarted.publish({ kind: 'agent_terminal', threadId: 't1', payload: {} }),
      10,
    );
    const result = await pending;
    expect(result.events.map((e) => e.seq)).toEqual([1]);
  });

  test('without an epoch the since filter is unchanged (older consumers do not replay)', () => {
    // An older consumer never lowers its cursor; answering it from 0 would
    // return the same events on every poll.
    const restarted = createSchedulerEventBuffer();
    restarted.publish({ kind: 'agent_terminal', threadId: 't1', payload: {} });
    expect(restarted.getSince(500).events).toHaveLength(0);
  });

  test('the current epoch keeps the normal since filter', () => {
    const buf = createSchedulerEventBuffer();
    buf.publish({ kind: 'agent_terminal', threadId: 't1', payload: {} });
    buf.publish({ kind: 'agent_terminal', threadId: 't2', payload: {} });
    expect(buf.getSince(1, buf.epoch).events.map((e) => e.seq)).toEqual([2]);
    expect(buf.getSince(2, buf.epoch).events).toHaveLength(0);
  });
});
