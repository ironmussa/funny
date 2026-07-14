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

function makeRecoveryRouter(state: AgentStateTracker) {
  const orchestrator = { on: vi.fn() } as any;
  const messageHandler = {} as any;
  const threadManager = {
    getThread: vi.fn(async () => ({
      id: 't-1',
      projectId: 'p-1',
      userId: 'u-1',
      status: 'waiting',
      cost: 0,
    })),
    updateThread: vi.fn(async () => undefined),
    expirePendingPermissionRequest: vi.fn(async () => undefined),
  } as any;
  const wsBroker = { emit: vi.fn(), emitToUser: vi.fn() } as any;
  return {
    router: new AgentEventRouter(orchestrator, state, messageHandler, threadManager, wsBroker),
    threadManager,
    wsBroker,
  };
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

describe('AgentEventRouter — lost structured permission recovery', () => {
  test('expires the request and leaves the thread in recovery waiting state when the process exits', async () => {
    const state = new AgentStateTracker();
    state.structuredPermissionRequests.set('t-1', {
      requestId: 'request-1',
      threadId: 't-1',
      runId: 'run-1',
      transport: 'codex-acp',
      toolCallId: 'tool-1',
      toolName: 'Bash',
      canAlwaysAllow: true,
      canDeny: true,
      requestedAt: '2026-07-13T00:00:00.000Z',
    });
    const { router, threadManager, wsBroker } = makeRecoveryRouter(state);

    try {
      await (router as any).handleAgentFailure('t-1', 'ACP process exited');

      expect(threadManager.expirePendingPermissionRequest).toHaveBeenCalledWith('request-1');
      expect(threadManager.updateThread).toHaveBeenCalledWith(
        't-1',
        expect.objectContaining({
          status: 'waiting',
          contextRecoveryReason: 'permission-request-expired',
        }),
      );
      expect(wsBroker.emitToUser).toHaveBeenCalledWith(
        'u-1',
        expect.objectContaining({
          type: 'agent:status',
          data: expect.objectContaining({
            status: 'waiting',
            permissionRecoveryReason: 'runner_lost',
          }),
        }),
      );
    } finally {
      router.destroy();
    }
  });
});
