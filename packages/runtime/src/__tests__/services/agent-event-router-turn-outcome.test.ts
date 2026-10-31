/**
 * Every finished run records how the latest user turn ended (`turn_outcome`),
 * so a stopped turn still reads as stopped after later turns or a reload.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';

import { AgentEventRouter } from '../../services/agent-event-router.js';
import { AgentStateTracker } from '../../services/agent-state.js';

const saveThreadEvent = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: { getProject: vi.fn(async () => ({ id: 'p-1', path: '/tmp/proj' })) },
    threadEvents: { saveThreadEvent },
  }),
}));

describe('AgentEventRouter turn outcome', () => {
  let router: AgentEventRouter | undefined;
  afterEach(() => {
    router?.destroy();
    vi.clearAllMocks();
  });

  test('persists and broadcasts a stopped outcome for the latest user message', async () => {
    const threadManager = {
      getThread: vi.fn(),
      updateThread: vi.fn(),
      getThreadWithMessages: vi.fn(async () => ({ lastUserMessage: { id: 'msg-user-1' } })),
    } as any;
    const wsBroker = { emit: vi.fn(), emitToUser: vi.fn() } as any;
    router = new AgentEventRouter(
      { on: vi.fn() } as any,
      new AgentStateTracker(),
      {} as any,
      threadManager,
      wsBroker,
    );

    await router.emitAgentCompleted('t-1', { projectId: 'p-1', userId: 'u-1' }, 'stopped');

    await vi.waitFor(() => expect(saveThreadEvent).toHaveBeenCalled());
    expect(saveThreadEvent).toHaveBeenCalledWith(
      't-1',
      'turn_outcome',
      expect.objectContaining({ userMessageId: 'msg-user-1', status: 'stopped' }),
    );
    expect(wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'thread:event',
        data: expect.objectContaining({
          event: expect.objectContaining({ type: 'turn_outcome' }),
        }),
      }),
    );
  });
});
