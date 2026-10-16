/**
 * Regression: per-thread message handling must stay strictly sequential.
 *
 * A periodic cleanup used to drop a thread's queue entry once an EARLIER
 * promise had settled, even if a later message was still being handled — the
 * next message then started concurrently, out of order.
 */
import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { AgentEventRouter } from '../../services/agent-event-router.js';
import { AgentStateTracker } from '../../services/agent-state.js';

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({ projects: { getProject: vi.fn() } }),
}));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe('AgentEventRouter message queue', () => {
  let router: AgentEventRouter | undefined;
  afterEach(() => {
    router?.destroy();
    vi.useRealTimers();
  });

  test('a long-running handler is never overtaken, across cleanup ticks', async () => {
    vi.useFakeTimers();
    const orchestrator = new EventEmitter();
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const events: string[] = [];
    const messageHandler = {
      handle: async (_threadId: string, msg: { id: string }) => {
        events.push(`start ${msg.id}`);
        const gate = deferred();
        gates.set(msg.id, gate);
        await gate.promise;
        events.push(`end ${msg.id}`);
      },
    };
    router = new AgentEventRouter(
      orchestrator as any,
      new AgentStateTracker(),
      messageHandler as any,
      { getThread: vi.fn(), updateThread: vi.fn() } as any,
      { emit: vi.fn(), emitToUser: vi.fn() } as any,
    );

    orchestrator.emit('agent:message', 't1', { id: 'm1' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    gates.get('m1')!.resolve();
    await vi.advanceTimersByTimeAsync(0);

    orchestrator.emit('agent:message', 't1', { id: 'm2' });
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    orchestrator.emit('agent:message', 't1', { id: 'm3' });
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toEqual(['start m1', 'end m1', 'start m2']);
    gates.get('m2')!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    gates.get('m3')!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toEqual(['start m1', 'end m1', 'start m2', 'end m2', 'start m3', 'end m3']);
    // The queue entry is released once the thread goes idle (no timer needed).
    expect((router as any).messageQueues.size).toBe(0);
  });
});
