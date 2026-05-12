/**
 * Unit tests for OrchestratorEventBuffer.
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

import { createOrchestratorEventBuffer } from '../../services/orchestrator-event-buffer.js';

describe('OrchestratorEventBuffer', () => {
  test('publish assigns monotonic seq starting at 1', () => {
    const buf = createOrchestratorEventBuffer();
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
    const buf = createOrchestratorEventBuffer();
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
    const buf = createOrchestratorEventBuffer();
    buf.publish({ kind: 'agent_terminal', threadId: 't1', payload: {} });
    const result = await buf.waitForEvents(0, 5_000);
    expect(result.events).toHaveLength(1);
    expect(result.nextSeq).toBe(1);
  });

  test('waitForEvents blocks then resolves on publish', async () => {
    const buf = createOrchestratorEventBuffer();
    const promise = buf.waitForEvents(0, 5_000);
    setTimeout(() => {
      buf.publish({ kind: 'agent_terminal', threadId: 't1', payload: { kind: 'completed' } });
    }, 20);
    const result = await promise;
    expect(result.events).toHaveLength(1);
    expect(result.events[0].threadId).toBe('t1');
  });

  test('waitForEvents resolves with empty events on timeout', async () => {
    const buf = createOrchestratorEventBuffer();
    const start = Date.now();
    const result = await buf.waitForEvents(0, 60);
    const elapsed = Date.now() - start;
    expect(result.events).toEqual([]);
    expect(result.nextSeq).toBe(0);
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });

  test('capacity trims oldest events but seq stays monotonic', () => {
    const buf = createOrchestratorEventBuffer({ capacity: 3 });
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
    const buf = createOrchestratorEventBuffer();
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
});
