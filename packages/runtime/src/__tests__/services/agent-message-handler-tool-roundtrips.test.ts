// Tool calls must not pay server round trips the runner can answer itself:
// no duplicate lookup for messages this process created, and no tool-call
// fetch on tool_result when the tool name is already known.

import type { CLIMessage } from '@funny/core/agents';
import { describe, expect, test, vi } from 'vitest';

import { AgentMessageHandler } from '../../services/agent-message-handler.js';
import { AgentStateTracker } from '../../services/agent-state.js';

const THREAD_ID = 'thread-roundtrips';

function setup() {
  const state = new AgentStateTracker();
  state.threadUserIds.set(THREAD_ID, 'user-1');
  let ids = 0;
  const tm = {
    getThread: vi.fn(async () => ({ userId: 'user-1', projectId: 'p1', status: 'running' })),
    updateThread: vi.fn(async () => undefined),
    insertMessage: vi.fn(async () => `msg-${++ids}`),
    updateMessage: vi.fn(async () => undefined),
    findToolCall: vi.fn(async (): Promise<{ id: string } | undefined> => undefined),
    insertToolCall: vi.fn(async () => `tc-${++ids}`),
    getToolCall: vi.fn(async (_id: string): Promise<any> => undefined),
    updateToolCallOutput: vi.fn(async () => undefined),
  };
  const emitted: any[] = [];
  const handler = new AgentMessageHandler(
    state,
    tm as any,
    { emit: vi.fn(), emitToUser: vi.fn((_u: string, e: any) => emitted.push(e)) } as any,
    () => undefined,
  );
  return { state, tm, handler, emitted };
}

function toolUse(cliMsgId: string, id: string, name: string, input: object = {}): CLIMessage {
  return {
    type: 'assistant',
    hasStableMessageId: true,
    message: { id: cliMsgId, content: [{ type: 'tool_use', id, name, input }] },
  } as CLIMessage;
}

function toolResult(toolUseId: string, content: string): CLIMessage {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
  } as CLIMessage;
}

describe('AgentMessageHandler — tool call round trips', () => {
  test('a new tool call skips the DB duplicate lookup and the result skips the tool-call fetch', async () => {
    const { tm, handler, emitted } = setup();

    await handler.handle(THREAD_ID, toolUse('cli-1', 'tu-1', 'Read', { file_path: 'a.ts' }));
    await handler.handle(THREAD_ID, toolResult('tu-1', 'file contents'));

    expect(tm.insertToolCall).toHaveBeenCalledTimes(1);
    expect(tm.findToolCall).not.toHaveBeenCalled();
    expect(tm.getToolCall).not.toHaveBeenCalled();
    const toolCallId = (await tm.insertToolCall.mock.results[0].value) as string;
    expect(tm.updateToolCallOutput).toHaveBeenCalledWith(toolCallId, 'file contents');
    expect(emitted.map((e) => e.type)).toEqual(['agent:tool_call', 'agent:tool_output']);
  });

  test('a tool call under a message from before a restart still checks the DB for duplicates', async () => {
    const { state, tm, handler } = setup();
    // Message known from an earlier process (not created by this one).
    state.cliToDbMsgId.set(THREAD_ID, new Map([['cli-old', 'msg-old']]));
    tm.findToolCall.mockResolvedValueOnce({ id: 'tc-old' });

    await handler.handle(THREAD_ID, toolUse('cli-old', 'tu-old', 'Read'));

    expect(tm.findToolCall).toHaveBeenCalledWith('msg-old', 'Read', '{}');
    expect(tm.insertToolCall).not.toHaveBeenCalled();
    expect(state.processedToolUseIds.get(THREAD_ID)?.get('tu-old')).toBe('tc-old');

    // The name was recorded too, so its result needs no fetch.
    await handler.handle(THREAD_ID, toolResult('tu-old', 'ok'));
    expect(tm.getToolCall).not.toHaveBeenCalled();
  });

  test('interactive tools and unknown tool calls still read the tool-call row', async () => {
    const { state, tm, handler } = setup();

    await handler.handle(THREAD_ID, toolUse('cli-1', 'tu-ask', 'AskUserQuestion', { q: 1 }));
    const askId = (await tm.insertToolCall.mock.results[0].value) as string;
    tm.getToolCall.mockResolvedValueOnce({ name: 'AskUserQuestion', output: null });
    state.pendingUserInput.delete(THREAD_ID);
    await handler.handle(THREAD_ID, toolResult('tu-ask', 'the answer'));
    expect(tm.getToolCall).toHaveBeenCalledWith(askId);

    // Known tool_use id whose name was lost (e.g. state restored from elsewhere).
    state.processedToolUseIds.get(THREAD_ID)!.set('tu-unknown', 'tc-unknown');
    tm.getToolCall.mockResolvedValueOnce({ name: 'Read', input: '{}' });
    await handler.handle(THREAD_ID, toolResult('tu-unknown', 'ok'));
    expect(tm.getToolCall).toHaveBeenCalledWith('tc-unknown');
  });

  test('a permission denial on a known tool fetches the input it needs', async () => {
    const { state, tm, handler } = setup();

    await handler.handle(THREAD_ID, toolUse('cli-1', 'tu-w', 'Bash', { command: 'rm x' }));
    const id = (await tm.insertToolCall.mock.results[0].value) as string;
    tm.getToolCall.mockResolvedValueOnce({ name: 'Bash', input: '{"command":"rm x"}' });

    await handler.handle(THREAD_ID, toolResult('tu-w', 'Claude requested permissions to use Bash'));

    expect(tm.getToolCall).toHaveBeenCalledWith(id);
    expect(state.pendingPermissionRequest.get(THREAD_ID)).toMatchObject({
      toolName: 'Bash',
      toolUseId: 'tu-w',
    });
  });

  describe('changed-files summary at turn end', () => {
    function withThread(pages: any[]) {
      const ctx = setup();
      const getThreadWithMessages = vi.fn(async () => pages.shift());
      (ctx.tm as any).getThreadWithMessages = getThreadWithMessages;
      return { ...ctx, getThreadWithMessages };
    }
    const load = (handler: AgentMessageHandler) => (handler as any).loadLatestTurn(THREAD_ID);
    const LIMIT = AgentMessageHandler.LATEST_TURN_WINDOW;

    test('loads only the newest window when it contains the latest user message', async () => {
      const page = { hasMore: true, messages: [{ role: 'user' }, { role: 'assistant' }] };
      const { handler, getThreadWithMessages } = withThread([page]);
      expect(await load(handler)).toBe(page);
      expect(getThreadWithMessages).toHaveBeenCalledTimes(1);
      expect(getThreadWithMessages).toHaveBeenCalledWith(THREAD_ID, LIMIT);
    });

    test('falls back to the full history when the turn started before the window', async () => {
      const full = { hasMore: false, messages: [{ role: 'user' }, { role: 'assistant' }] };
      const { handler, getThreadWithMessages } = withThread([
        { hasMore: true, messages: [{ role: 'assistant' }] },
        full,
      ]);
      expect(await load(handler)).toBe(full);
      expect(getThreadWithMessages).toHaveBeenNthCalledWith(2, THREAD_ID);
    });

    test('a window that already holds the whole thread needs no second fetch', async () => {
      const page = { hasMore: false, messages: [{ role: 'assistant' }] };
      const { handler, getThreadWithMessages } = withThread([page]);
      expect(await load(handler)).toBe(page);
      expect(getThreadWithMessages).toHaveBeenCalledTimes(1);
    });
  });
});
