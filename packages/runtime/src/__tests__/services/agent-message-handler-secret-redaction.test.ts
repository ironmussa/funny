// Project secrets the agent was started with never reach the stored transcript
// or the live stream as is (openspec project-secrets): message text, tool
// input and tool output all carry `[secret:NAME]`, the same in both places.

import type { CLIMessage } from '@funny/core/agents';
import { createSecretRedactor } from '@funny/shared/project-secrets';
import { describe, expect, test, vi } from 'vitest';

import { AgentMessageHandler } from '../../services/agent-message-handler.js';
import { AgentStateTracker } from '../../services/agent-state.js';
import { buildThreadRecord, createThreadManagerFake } from '../helpers/builders.js';

const THREAD_ID = 'thread-redaction';
const SECRET = 'sk-live-0123456789';

function setup(secrets = [{ name: 'STRIPE_KEY', value: SECRET }]) {
  const state = new AgentStateTracker();
  state.threadUserIds.set(THREAD_ID, 'user-1');
  if (secrets.length > 0) state.secretRedactors.set(THREAD_ID, createSecretRedactor(secrets));
  let ids = 0;
  const tm = {
    ...createThreadManagerFake(),
    getThread: vi.fn(async () =>
      buildThreadRecord({ id: THREAD_ID, userId: 'user-1', projectId: 'p1', status: 'running' }),
    ),
    updateThread: vi.fn(async () => undefined),
    insertMessage: vi.fn(async (_message: { content: string }) => `msg-${++ids}`),
    updateMessage: vi.fn(async () => undefined),
    findToolCall: vi.fn(async (): Promise<{ id: string } | undefined> => undefined),
    insertToolCall: vi.fn(async (_call: { input: string }) => `tc-${++ids}`),
    getToolCall: vi.fn(async (_id: string): Promise<any> => undefined),
    updateToolCallOutput: vi.fn(async (_id: string, _output: string) => undefined),
  };
  const emitted: any[] = [];
  const handler = new AgentMessageHandler(
    state,
    tm,
    { emit: vi.fn(), emitToUser: vi.fn((_u: string, e: any) => emitted.push(e)) },
    () => undefined,
  );
  return { state, tm, handler, emitted };
}

const text = (cliMsgId: string, body: string): CLIMessage => ({
  type: 'assistant',
  hasStableMessageId: true,
  message: { id: cliMsgId, content: [{ type: 'text', text: body }] },
});

const toolUse = (cliMsgId: string, id: string, command: string): CLIMessage => ({
  type: 'assistant',
  hasStableMessageId: true,
  message: {
    id: cliMsgId,
    content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }],
  },
});

const toolResult = (toolUseId: string, content: string): CLIMessage => ({
  type: 'user',
  message: { content: [{ type: 'tool_result', tool_use_id: toolUseId, content }] },
});

describe('AgentMessageHandler — project secret redaction', () => {
  test('message text, tool input and tool output are redacted, stored and emitted alike', async () => {
    const { tm, handler, emitted } = setup();

    await handler.handle(THREAD_ID, text('cli-1', `the key is ${SECRET}`));
    await handler.handle(THREAD_ID, toolUse('cli-2', 'tu-1', `curl -H "Bearer ${SECRET}"`));
    await handler.handle(THREAD_ID, toolResult('tu-1', `STRIPE_KEY=${SECRET}\n`));

    const storedText = tm.insertMessage.mock.calls[0][0].content;
    expect(storedText).toBe('the key is [secret:STRIPE_KEY]');
    const storedInput = tm.insertToolCall.mock.calls[0][0].input;
    expect(storedInput).toBe('{"command":"curl -H \\"Bearer [secret:STRIPE_KEY]\\""}');
    const storedOutput = tm.updateToolCallOutput.mock.calls[0][1];
    expect(storedOutput).toContain('STRIPE_KEY=[secret:STRIPE_KEY]');

    const byType = (type: string) => emitted.find((event) => event.type === type)?.data;
    expect(byType('agent:message').content).toBe(storedText);
    expect(JSON.stringify(byType('agent:tool_call').input)).toBe(storedInput);
    expect(byType('agent:tool_output').output).toBe(storedOutput);

    expect(JSON.stringify(emitted)).not.toContain(SECRET);
    expect(JSON.stringify(tm.insertMessage.mock.calls)).not.toContain(SECRET);
  });

  test('a thread started without secrets is left as is', async () => {
    const { tm, handler } = setup([]);
    await handler.handle(THREAD_ID, text('cli-1', `the key is ${SECRET}`));
    expect(tm.insertMessage.mock.calls[0][0].content).toBe(`the key is ${SECRET}`);
  });

  test('the redactor goes when the thread state is cleaned up', () => {
    const { state } = setup();
    state.cleanupThread(THREAD_ID);
    expect(state.secretRedactors.has(THREAD_ID)).toBe(false);
  });
});
