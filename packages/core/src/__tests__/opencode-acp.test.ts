/**
 * Tests for OpenCodeACPProcess.translateUpdate().
 *
 * The translation logic is cloned from CursorACPProcess (both are dynamic-model
 * ACP adapters), so these focus on confirming the OpenCode adapter is correctly
 * wired to the shared ACP helpers and emits the right CLIMessage stream for the
 * representative update shapes opencode produces: streaming text, tool calls,
 * buffered reasoning (Think), plan→TodoWrite, and usage.
 */

import { describe, expect, test } from 'vitest';

import { OpenCodeACPProcess } from '../agents/opencode-acp.js';
import type { CLIMessage } from '../agents/types.js';

function makeProcess(): { proc: OpenCodeACPProcess; messages: CLIMessage[] } {
  const proc = new OpenCodeACPProcess({
    prompt: 'test',
    cwd: '/tmp/test',
    model: 'default',
  });
  const messages: CLIMessage[] = [];
  proc.on('message', (m: CLIMessage) => messages.push(m));
  return { proc, messages };
}

function translate(proc: OpenCodeACPProcess, update: unknown): void {
  // translateUpdate is private; tests reach in deliberately.
  (proc as unknown as { translateUpdate: (u: unknown) => void }).translateUpdate(update);
}

describe('OpenCodeACPProcess.translateUpdate', () => {
  test('agent_message_chunk accumulates streaming text under one message id', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hola ' },
    });
    translate(proc, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'mundo' },
    });

    expect(messages).toHaveLength(2);
    const m0 = messages[0];
    const m1 = messages[1];
    if (m0.type !== 'assistant' || m1.type !== 'assistant') throw new Error('unreachable');
    expect(m0.message.id).toBe(m1.message.id);
    expect(m1.message.content[0]).toMatchObject({ type: 'text', text: 'Hola mundo' });
  });

  test('Bash tool_call uses rawInput.command', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'exec-1',
      kind: 'execute',
      title: 'Run Command',
      rawInput: { command: 'git status' },
    });

    const m = messages[0];
    if (m.type !== 'assistant') throw new Error('unreachable');
    const block = m.message.content[0];
    expect(block).toMatchObject({ type: 'tool_use', name: 'Bash' });
    if (block.type !== 'tool_use') throw new Error('unreachable');
    expect(block.input).toMatchObject({ command: 'git status' });
  });

  test('completed tool_call emits a matching tool_result', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'read-1',
      kind: 'read',
      title: 'Read File',
      rawInput: { target_file: '/repo/pkg.json' },
      status: 'completed',
      rawOutput: { content: '{ "name": "x" }' },
    });

    expect(messages).toHaveLength(2);
    const result = messages[1];
    if (result.type !== 'user') throw new Error('unreachable');
    expect(result.message.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'read-1',
      content: '{ "name": "x" }',
    });
  });

  test('agent_thought_chunk buffers thought and flushes as Think on next event', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'planning the search' },
    });
    expect(messages).toHaveLength(0);

    translate(proc, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'go' },
    });

    expect(messages.length).toBeGreaterThanOrEqual(3);
    const thinkUse = messages[0];
    if (thinkUse.type !== 'assistant') throw new Error('unreachable');
    expect(thinkUse.message.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'Think',
      input: { content: 'planning the search' },
    });
  });

  test('plan update emits a TodoWrite card', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Open file', status: 'completed', priority: 'high' },
        { content: 'Edit file', status: 'in_progress', priority: 'medium' },
      ],
    });

    expect(messages).toHaveLength(2);
    const use = messages[0];
    if (use.type !== 'assistant') throw new Error('unreachable');
    const block = use.message.content[0];
    expect(block).toMatchObject({ type: 'tool_use', name: 'TodoWrite' });
    if (block.type !== 'tool_use') throw new Error('unreachable');
    expect(block.input).toEqual({
      todos: [
        { content: 'Open file', status: 'completed' },
        { content: 'Edit file', status: 'in_progress' },
      ],
    });
  });

  test('usage_update emits a synthetic assistant message with token usage', () => {
    const { proc, messages } = makeProcess();

    translate(proc, { sessionUpdate: 'usage_update', used: 42_000, size: 400_000 });

    expect(messages).toHaveLength(1);
    const m = messages[0];
    if (m.type !== 'assistant') throw new Error('unreachable');
    expect(m.message.usage).toMatchObject({ input_tokens: 42_000 });
  });
});
