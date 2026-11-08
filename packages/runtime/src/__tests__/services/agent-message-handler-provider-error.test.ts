import type { CLIMessage } from '@funny/core/agents';
import { describe, test, expect, vi } from 'vitest';

import { AgentMessageHandler } from '../../services/agent-message-handler.js';
import { AgentStateTracker } from '../../services/agent-state.js';

const THREAD_ID = 'thread-provider-error';

function makeHandler() {
  const state = new AgentStateTracker();
  state.threadUserIds.set(THREAD_ID, 'user-1');

  const emitted: Array<{ type: string; data: any }> = [];
  const wsBroker = {
    emit: vi.fn(),
    emitToUser: vi.fn((_userId: string, event: any) => {
      emitted.push({ type: event.type, data: event.data });
    }),
  };

  const updates: Array<Record<string, unknown>> = [];
  let toolCallSeq = 0;
  const threadManager = {
    getThread: vi.fn(async () => ({
      userId: 'user-1',
      projectId: 'proj-1',
      status: 'running',
      stage: 'review',
    })),
    insertMessage: vi.fn(async () => 'db-msg-1'),
    updateMessage: vi.fn(async () => undefined),
    findToolCall: vi.fn(async () => undefined),
    insertToolCall: vi.fn(async () => `tc-${++toolCallSeq}`),
    getToolCall: vi.fn(async () => undefined),
    updateToolCallOutput: vi.fn(async () => undefined),
    updateThread: vi.fn(async (_id: string, patch: Record<string, unknown>) => {
      updates.push(patch);
    }),
  };

  const handler = new AgentMessageHandler(
    state,
    threadManager as any,
    wsBroker as any,
    () => undefined,
  );
  return { handler, state, emitted, updates, threadManager };
}

function providerErrorAssistant(): CLIMessage {
  return {
    type: 'assistant',
    message: {
      id: 'cli-err',
      content: [
        {
          type: 'tool_use',
          id: 'tu-err-1',
          name: 'ProviderError',
          input: { error: 'API Error: Server is temporarily limiting requests · Rate limited' },
        },
      ],
    },
  } as unknown as CLIMessage;
}

function textAssistant(text: string): CLIMessage {
  return {
    type: 'assistant',
    message: { id: 'cli-text', content: [{ type: 'text', text }] },
  } as unknown as CLIMessage;
}

function successResult(): CLIMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    duration_ms: 10,
    num_turns: 1,
    result: 'done',
    total_cost_usd: 0.01,
    session_id: 'sess-1',
  } as unknown as CLIMessage;
}

describe('AgentMessageHandler — provider error → failed', () => {
  test('a ProviderError followed by a success result fails the thread', async () => {
    const { handler, state, emitted, updates } = makeHandler();

    await handler.handle(THREAD_ID, providerErrorAssistant());
    expect(state.providerErrorPending.has(THREAD_ID)).toBe(true);

    await handler.handle(THREAD_ID, successResult());

    // The process has exited: the thread must end `failed` — neither
    // `completed` nor `waiting` (nothing is waiting for input).
    const statusUpdate = updates.find((u) => 'status' in u);
    expect(statusUpdate?.status).toBe('failed');
    expect(statusUpdate && 'completedAt' in statusUpdate).toBe(true);

    const result = emitted.find((e) => e.type === 'agent:result');
    expect(result?.data.status).toBe('failed');
    expect(result?.data.waitingReason).toBeUndefined();
    expect(result?.data.errorReason).toBe('provider_error');
    expect(result?.data.error).toBe(
      'API Error: Server is temporarily limiting requests · Rate limited',
    );

    // Flag is cleared after the result so the next run starts clean.
    expect(state.providerErrorPending.has(THREAD_ID)).toBe(false);
  });

  test('a ProviderError that the agent recovers from completes normally', async () => {
    const { handler, state, emitted, updates } = makeHandler();

    await handler.handle(THREAD_ID, providerErrorAssistant());
    expect(state.providerErrorPending.has(THREAD_ID)).toBe(true);

    // Real progress after the error clears the pending flag.
    await handler.handle(THREAD_ID, textAssistant('Recovered, continuing the work.'));
    expect(state.providerErrorPending.has(THREAD_ID)).toBe(false);

    await handler.handle(THREAD_ID, successResult());

    const statusUpdate = updates.find((u) => 'status' in u);
    expect(statusUpdate?.status).toBe('completed');

    const result = emitted.find((e) => e.type === 'agent:result');
    expect(result?.data.status).toBe('completed');
    expect(result?.data.waitingReason).toBeUndefined();
  });
});
