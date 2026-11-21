import { afterEach, describe, expect, test, vi } from 'bun:test';

/**
 * Regression: per-thread message handling must stay strictly sequential.
 *
 * A periodic cleanup used to drop a thread's queue entry once an EARLIER
 * promise had settled, even if a later message was still being handled — the
 * next message then started concurrently, out of order.
 */
import type { CLIMessage } from '@funny/core/agents';
import { advanceTimersByTimeAsync } from '@funny/test-kit';

import { AgentEventRouter } from '../../services/agent-event-router.js';
import { AgentStateTracker } from '../../services/agent-state.js';
import { createMessageHandler, createOrchestrator } from '../helpers/builders-handlers.js';
import { createThreadManagerFake, createWsBrokerFake } from '../helpers/builders.js';

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({ projects: { getProject: vi.fn() } }),
}));

function assistantMessage(id: string): CLIMessage {
  return { type: 'assistant', message: { id, content: [] } };
}

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
    const orchestrator = createOrchestrator();
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const events: string[] = [];
    const state = new AgentStateTracker();
    const messageHandler = createMessageHandler(state);
    vi.spyOn(messageHandler, 'handle').mockImplementation(async (_threadId, msg) => {
      const id = msg.type === 'assistant' ? msg.message.id : msg.type;
      events.push(`start ${id}`);
      const gate = deferred();
      gates.set(id, gate);
      await gate.promise;
      events.push(`end ${id}`);
    });
    router = new AgentEventRouter(
      orchestrator,
      state,
      messageHandler,
      createThreadManagerFake(),
      createWsBrokerFake(),
    );

    orchestrator.emit('agent:message', 't1', assistantMessage('m1'));
    await advanceTimersByTimeAsync(5 * 60_000);
    gates.get('m1')!.resolve();
    await advanceTimersByTimeAsync(0);

    orchestrator.emit('agent:message', 't1', assistantMessage('m2'));
    await advanceTimersByTimeAsync(5 * 60_000);
    orchestrator.emit('agent:message', 't1', assistantMessage('m3'));
    await advanceTimersByTimeAsync(0);

    expect(events).toEqual(['start m1', 'end m1', 'start m2']);
    gates.get('m2')!.resolve();
    await advanceTimersByTimeAsync(0);
    gates.get('m3')!.resolve();
    await advanceTimersByTimeAsync(0);
    expect(events).toEqual(['start m1', 'end m1', 'start m2', 'end m2', 'start m3', 'end m3']);
    // The queue entry is released once the thread goes idle (no timer needed).
    expect(router['messageQueues'].size).toBe(0);
  });
});
