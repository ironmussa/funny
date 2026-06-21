import type { CLIMessage } from '@funny/core/agents';
import { describe, test, expect, vi } from 'vitest';

import { AgentMessageHandler } from '../../services/agent-message-handler.js';
import { AgentStateTracker } from '../../services/agent-state.js';

const THREAD_ID = 'thread-compact';

function makeHandler() {
  const state = new AgentStateTracker();
  // Pre-seed the cached userId so emitWS doesn't hit the DB.
  state.threadUserIds.set(THREAD_ID, 'user-1');

  const emitted: Array<{ type: string; data: any }> = [];
  const wsBroker = {
    emit: vi.fn(),
    emitToUser: vi.fn((_userId: string, event: any) => {
      emitted.push({ type: event.type, data: event.data });
    }),
  };
  const threadManager = {
    getThread: vi.fn(async () => ({ userId: 'user-1' })),
    insertMessage: vi.fn(async () => 'db-msg-1'),
    updateMessage: vi.fn(async () => undefined),
  };

  const handler = new AgentMessageHandler(
    state,
    threadManager as any,
    wsBroker as any,
    () => undefined,
  );
  return { handler, state, emitted, wsBroker };
}

function assistantMsg(content: any[], usage: Record<string, number>): CLIMessage {
  return {
    type: 'assistant',
    message: { id: 'cli-1', content, usage },
  } as unknown as CLIMessage;
}

describe('AgentMessageHandler — compaction summary usage', () => {
  test('does NOT emit context_usage for the compaction-summary message', async () => {
    const { handler, emitted } = makeHandler();

    // The compaction-summary assistant message reports usage equal to the
    // FULL pre-compaction context it just read. Forwarding it would clobber
    // the compact_boundary reset and freeze the ring at the old value.
    await handler.handle(
      THREAD_ID,
      assistantMsg([{ type: 'compaction', content: 'summary…' }], {
        input_tokens: 4,
        cache_read_input_tokens: 174_000,
        cache_creation_input_tokens: 1_000,
        output_tokens: 200,
      }),
    );

    const usageEvents = emitted.filter((e) => e.type === 'agent:context_usage');
    expect(usageEvents).toHaveLength(0);
  });

  test('still emits context_usage for a normal assistant message', async () => {
    const { handler, emitted } = makeHandler();

    await handler.handle(
      THREAD_ID,
      assistantMsg([{ type: 'text', text: 'Hello' }], {
        input_tokens: 100,
        cache_read_input_tokens: 20_000,
        cache_creation_input_tokens: 0,
        output_tokens: 50,
      }),
    );

    const usageEvents = emitted.filter((e) => e.type === 'agent:context_usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].data.cumulativeInputTokens).toBe(20_100);
  });
});
