import { describe, test, expect, vi } from 'bun:test';

import type { CLIMessage } from '@funny/core/agents';

import { AgentMessageHandler } from '../../services/agent-message-handler.js';
import { AgentStateTracker } from '../../services/agent-state.js';
import { wireMessage } from '../helpers/builders-handlers.js';
import { buildThreadRecord, createThreadManagerFake } from '../helpers/builders.js';

const THREAD_ID = 'thread-compact';

function makeHandler(thread: Parameters<typeof buildThreadRecord>[0] = {}) {
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
  const threadManager = createThreadManagerFake({
    getThread: vi.fn(async () =>
      buildThreadRecord({ id: THREAD_ID, userId: 'user-1', provider: 'claude', ...thread }),
    ),
    insertMessage: vi.fn(async () => 'db-msg-1'),
    updateMessage: vi.fn(async () => undefined),
  });

  const handler = new AgentMessageHandler(state, threadManager, wsBroker, () => undefined);
  return { handler, state, emitted, wsBroker };
}

interface ClaudeUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
}

type AssistantContent = Extract<CLIMessage, { type: 'assistant' }>['message']['content'];

function assistantMsg(content: AssistantContent, usage: ClaudeUsage): CLIMessage {
  return { type: 'assistant', message: { id: 'cli-1', content, usage } };
}

/** The Claude SDK's compaction-summary block, which `CLIMessage` does not model. */
function compactionSummaryMsg(usage: ClaudeUsage): CLIMessage {
  return wireMessage(
    JSON.stringify({
      type: 'assistant',
      message: { id: 'cli-1', content: [{ type: 'compaction', content: 'summary…' }], usage },
    }),
  );
}

describe('AgentMessageHandler — compaction summary usage', () => {
  test('does NOT emit context_usage for the compaction-summary message', async () => {
    const { handler, emitted } = makeHandler();

    // The compaction-summary assistant message reports usage equal to the
    // FULL pre-compaction context it just read. Forwarding it would clobber
    // the compact_boundary reset and freeze the ring at the old value.
    await handler.handle(
      THREAD_ID,
      compactionSummaryMsg({
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

describe('AgentMessageHandler — context breakdown', () => {
  const breakdown = {
    model: 'claude-opus-5-5',
    totalTokens: 48_000,
    maxTokens: 1_000_000,
    percentage: 5,
    categories: [{ id: 'messages', name: 'Messages', tokens: 30_000, kind: 'used' as const }],
    mcpServers: [],
    memoryFiles: [],
    capturedAt: '2026-11-09T10:00:00.000Z',
  };

  test('forwards the snapshot on agent:context_usage with the tracked token count', async () => {
    const { handler, state, emitted } = makeHandler();
    state.cumulativeInputTokens.set(THREAD_ID, 50_000);

    await handler.handle(THREAD_ID, { type: 'context_breakdown', breakdown });

    const usageEvents = emitted.filter((e) => e.type === 'agent:context_usage');
    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0].data).toMatchObject({
      provider: 'claude',
      inputTokens: 50_000,
      outputTokens: 0,
      cumulativeInputTokens: 50_000,
      breakdown,
    });
  });

  test('falls back to the snapshot total when no usage was tracked yet', async () => {
    const { handler, emitted } = makeHandler();

    await handler.handle(THREAD_ID, { type: 'context_breakdown', breakdown });

    const [event] = emitted.filter((e) => e.type === 'agent:context_usage');
    expect(event.data.cumulativeInputTokens).toBe(48_000);
  });
});

describe('AgentMessageHandler — agent account provider scoping', () => {
  test('includes the message provider on agent:account events', async () => {
    const { handler, emitted } = makeHandler();

    await handler.handle(THREAD_ID, {
      type: 'account',
      provider: 'antigravity',
      info: { email: 'dev@google.com' },
    });

    const [event] = emitted.filter((e) => e.type === 'agent:account');
    expect(event.data).toMatchObject({
      provider: 'antigravity',
      account: { email: 'dev@google.com' },
    });
  });

  test('falls back to the thread provider when the account message omits one', async () => {
    const { handler, emitted } = makeHandler();

    await handler.handle(THREAD_ID, {
      type: 'account',
      info: { email: 'dev@example.com' },
    });

    const [event] = emitted.filter((e) => e.type === 'agent:account');
    expect(event.data).toMatchObject({
      provider: 'claude',
      account: { email: 'dev@example.com' },
    });
  });
});

describe('AgentMessageHandler — context usage run scoping', () => {
  test('tags usage with the run provider and model and forwards the reported window', async () => {
    const { handler, emitted } = makeHandler({ provider: 'antigravity', model: 'default' });

    await handler.handle(THREAD_ID, {
      type: 'assistant',
      message: {
        id: 'cli-1',
        content: [{ type: 'text', text: 'Hi' }],
        usage: { input_tokens: 30_000, output_tokens: 0, max_tokens: 1_048_576 },
      },
    });

    const [event] = emitted.filter((e) => e.type === 'agent:context_usage');
    expect(event.data).toMatchObject({
      provider: 'antigravity',
      model: 'default',
      maxTokens: 1_048_576,
      cumulativeInputTokens: 30_000,
    });
  });

  test('omits maxTokens when the provider does not report a window', async () => {
    const { handler, emitted } = makeHandler();

    await handler.handle(
      THREAD_ID,
      assistantMsg([{ type: 'text', text: 'Hello' }], {
        input_tokens: 100,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
        output_tokens: 1,
      }),
    );

    const [event] = emitted.filter((e) => e.type === 'agent:context_usage');
    expect(event.data.maxTokens).toBeUndefined();
    expect(event.data.provider).toBe('claude');
  });
});
