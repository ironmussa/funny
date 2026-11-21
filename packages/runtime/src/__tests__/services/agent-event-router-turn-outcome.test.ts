/**
 * Every finished run records how the latest user turn ended (`turn_outcome`),
 * so a stopped turn still reads as stopped after later turns or a reload.
 */
import { afterEach, describe, expect, test, vi } from 'bun:test';

import { waitFor } from '@funny/test-kit';

import { AgentEventRouter } from '../../services/agent-event-router.js';
import { AgentStateTracker } from '../../services/agent-state.js';
import { createMessageHandler, createOrchestrator } from '../helpers/builders-handlers.js';
import {
  buildThreadRecord,
  createThreadManagerFake,
  createWsBrokerFake,
} from '../helpers/builders.js';

const saveThreadEvent = (() => vi.fn(async () => undefined))();
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
    const threadManager = createThreadManagerFake({
      getThreadWithMessages: vi.fn(async () => ({
        ...buildThreadRecord({ id: 't-1' }),
        messages: [],
        lastUserMessage: { id: 'msg-user-1' },
      })),
    });
    const wsBroker = createWsBrokerFake();
    const state = new AgentStateTracker();
    router = new AgentEventRouter(
      createOrchestrator(),
      state,
      createMessageHandler(state),
      threadManager,
      wsBroker,
    );

    await router.emitAgentCompleted('t-1', { projectId: 'p-1', userId: 'u-1' }, 'stopped');

    await waitFor(() => expect(saveThreadEvent).toHaveBeenCalled());
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
