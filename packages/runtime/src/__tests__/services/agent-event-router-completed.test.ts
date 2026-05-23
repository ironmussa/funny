/**
 * Regression: bug 3b — `agent:completed` must only fire once per agent run.
 *
 * Multiple emission paths can resolve the same run (the SDK result handler,
 * agent:stopped, agent:error, agent:unexpected-exit). Without deduplication,
 * the queue handler dequeues the next follow-up message twice — the user sees
 * a queued message fire twice or fire before the agent finished.
 *
 * The guard lives in `AgentEventRouter.emitAgentCompleted` and uses
 * `AgentStateTracker.completedEmitted` so it survives across the two
 * different emission paths. `clearRunState` resets the flag so subsequent
 * runs for the same thread emit normally.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

import { AgentEventRouter } from '../../services/agent-event-router.js';
import { AgentStateTracker } from '../../services/agent-state.js';
import { threadEventBus, type AgentCompletedEvent } from '../../services/thread-event-bus.js';

// ── Mocks ────────────────────────────────────────────────────────

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: { getProject: vi.fn(async () => ({ id: 'p-1', path: '/tmp/proj' })) },
  }),
}));

function makeRouter(state: AgentStateTracker): AgentEventRouter {
  // The constructor calls subscribeOrchestrator / subscribeEventBus /
  // startQueueCleanup — provide minimal mocks that satisfy those.
  const orchestrator = { on: vi.fn() } as any;
  const messageHandler = {} as any;
  const threadManager = { getThread: vi.fn(), updateThread: vi.fn() } as any;
  const wsBroker = { emit: vi.fn(), emitToUser: vi.fn() } as any;
  return new AgentEventRouter(orchestrator, state, messageHandler, threadManager, wsBroker);
}

// ── Tests ────────────────────────────────────────────────────────

describe('AgentEventRouter.emitAgentCompleted — idempotency (bug 3b)', () => {
  let state: AgentStateTracker;
  let router: AgentEventRouter;
  let handler: (event: AgentCompletedEvent) => void;

  beforeEach(() => {
    state = new AgentStateTracker();
    router = makeRouter(state);
    handler = vi.fn() as unknown as (event: AgentCompletedEvent) => void;
    threadEventBus.on('agent:completed', handler);
  });

  afterEach(() => {
    threadEventBus.off('agent:completed', handler);
    router.destroy();
  });

  test('emits once on first call', async () => {
    await router.emitAgentCompleted('t-1', { projectId: 'p-1', userId: 'u-1' }, 'completed');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(state.completedEmitted.has('t-1')).toBe(true);
  });

  test('suppresses a second emission for the same run', async () => {
    // Simulate the SDK result path firing first…
    await router.emitAgentCompleted('t-1', { projectId: 'p-1', userId: 'u-1' }, 'completed');
    // …then a stop / failure path racing in. The second emit must be a no-op
    // so the queue handler doesn't dequeue the next follow-up twice.
    await router.emitAgentCompleted('t-1', { projectId: 'p-1', userId: 'u-1' }, 'stopped');
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('different threads do not block each other', async () => {
    await router.emitAgentCompleted('t-1', { projectId: 'p-1', userId: 'u-1' }, 'completed');
    await router.emitAgentCompleted('t-2', { projectId: 'p-1', userId: 'u-1' }, 'completed');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test('clearRunState lets the next run emit again', async () => {
    await router.emitAgentCompleted('t-1', { projectId: 'p-1', userId: 'u-1' }, 'completed');
    expect(handler).toHaveBeenCalledTimes(1);

    // Simulate startAgent for a follow-up: clears completedEmitted for t-1.
    state.clearRunState('t-1');

    await router.emitAgentCompleted('t-1', { projectId: 'p-1', userId: 'u-1' }, 'completed');
    expect(handler).toHaveBeenCalledTimes(2);
  });
});
