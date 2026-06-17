/**
 * Regression tests for PiACPProcess.translateUpdate().
 *
 * Pi-specific behaviors covered:
 *   - Pi prepends a `pi vX.Y.Z\n---\n## Skills…` banner to its first
 *     agent_message_chunk. The adapter strips it via `stripPiBanner` before
 *     emitting the assistant text so the banner doesn't pollute the chat.
 *   - Like codex, an orphan tool_call_update only emits a tool_result — Pi
 *     never synthesizes a tool_use.
 *   - agent_thought_chunk buffers reasoning text and flushes as a Think
 *     tool_use+tool_result pair on the next non-thought event.
 */

import { describe, expect, test } from 'vitest';

import { PiACPProcess } from '../agents/pi-acp.js';
import type { CLIMessage } from '../agents/types.js';

function makeProcess(): { proc: PiACPProcess; messages: CLIMessage[] } {
  const proc = new PiACPProcess({
    prompt: 'test',
    cwd: '/tmp/test',
    model: 'default',
  });
  const messages: CLIMessage[] = [];
  proc.on('message', (m: CLIMessage) => messages.push(m));
  return { proc, messages };
}

function translate(proc: PiACPProcess, update: unknown): void {
  (proc as unknown as { translateUpdate: (u: unknown) => void }).translateUpdate(update);
}

describe('PiACPProcess.translateUpdate', () => {
  test('strips the `pi vX.Y.Z\\n---\\n## Skills…` banner from the first message chunk', () => {
    const { proc, messages } = makeProcess();

    const banner =
      'pi v0.70.2\n' +
      '---\n' +
      '\n' +
      '## Skills\n' +
      '- /home/me/skills/example/SKILL.md\n' +
      '- /home/me/skills/another/SKILL.md\n' +
      '\n';
    translate(proc, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: banner + 'Hello world' },
    });

    expect(messages).toHaveLength(1);
    const m = messages[0];
    if (m.type !== 'assistant') throw new Error('unreachable');
    const block = m.message.content[0];
    if (block.type !== 'text') throw new Error('unreachable');
    expect(block.text).toBe('Hello world');
  });

  test('emits nothing when only the banner is present (no real text yet)', () => {
    const { proc, messages } = makeProcess();
    translate(proc, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'pi v0.70.2\n---\n' },
    });
    // stripBanner reduces this to '' so no assistant message is emitted.
    expect(messages).toHaveLength(0);
  });

  test('strips pi MCP adapter source/dependency bullets before assistant text', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text:
          'pi v0.70.2\n' +
          '---\n' +
          '- index.ts\n' +
          '- npm:pi-mcp-adapter\n' +
          '  - index.ts\n' +
          '¡Hola! ¿En qué puedo ayudarte?',
      },
    });

    expect(messages).toHaveLength(1);
    const m = messages[0];
    if (m.type !== 'assistant') throw new Error('unreachable');
    const block = m.message.content[0];
    if (block.type !== 'text') throw new Error('unreachable');
    expect(block.text).toBe('¡Hola! ¿En qué puedo ayudarte?');
  });

  test('tool_call (read) populates file_path from rawInput', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'read-1',
      kind: 'read',
      title: 'read /repo/foo.ts',
      rawInput: { file_path: '/repo/foo.ts' },
      locations: [{ path: '/repo/foo.ts' }],
    });

    expect(messages).toHaveLength(1);
    const m = messages[0];
    if (m.type !== 'assistant') throw new Error('unreachable');
    const block = m.message.content[0];
    expect(block).toMatchObject({ type: 'tool_use', id: 'read-1', name: 'Read' });
    if (block.type !== 'tool_use') throw new Error('unreachable');
    expect(block.input).toMatchObject({ file_path: '/repo/foo.ts' });
  });

  test('completed tool_call emits both tool_use and tool_result with raw output', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'exec-1',
      kind: 'execute',
      title: 'ls',
      rawInput: { command: 'ls' },
      status: 'completed',
      rawOutput: 'README.md\nsrc',
    });

    expect(messages).toHaveLength(2);
    const result = messages[1];
    if (result.type !== 'user') throw new Error('unreachable');
    expect(result.message.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'exec-1',
      content: 'README.md\nsrc',
    });
  });

  test('orphan tool_call_update only emits tool_result (no synthetic tool_use)', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'orphan-1',
      status: 'completed',
      kind: 'execute',
      title: 'whoami',
      rawInput: { command: 'whoami' },
      rawOutput: 'me',
    });

    // Pi differs from Cursor/Gemini: just a tool_result, no synthesized tool_use.
    expect(messages).toHaveLength(1);
    const m = messages[0];
    expect(m.type).toBe('user');
    if (m.type !== 'user') throw new Error('unreachable');
    expect(m.message.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'orphan-1',
      content: 'me',
    });
  });

  test('agent_thought_chunk flushes as a Think pair on next event', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking out loud' },
    });
    expect(messages).toHaveLength(0);

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'after-thought',
      kind: 'execute',
      title: 'ls',
      rawInput: { command: 'ls' },
    });

    // Expect Think tool_use + Think tool_result emitted before the ls tool_call.
    expect(messages.length).toBeGreaterThanOrEqual(3);
    const thinkUse = messages[0];
    if (thinkUse.type !== 'assistant') throw new Error('unreachable');
    expect(thinkUse.message.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'Think',
      input: { content: 'thinking out loud' },
    });
    const thinkResult = messages[1];
    if (thinkResult.type !== 'user') throw new Error('unreachable');
    expect(thinkResult.message.content[0]).toMatchObject({
      type: 'tool_result',
      content: 'thinking out loud',
    });
  });

  test('plan update emits a Plan markdown message', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'plan',
      entries: [
        { title: 'Read', status: 'completed' },
        { title: 'Edit', status: 'in_progress' },
      ],
    });

    expect(messages).toHaveLength(1);
    const m = messages[0];
    if (m.type !== 'assistant') throw new Error('unreachable');
    const block = m.message.content[0];
    if (block.type !== 'text') throw new Error('unreachable');
    expect(block.text).toContain('**Plan:**');
    expect(block.text).toContain('[x] 1. Read');
    expect(block.text).toContain('[~] 2. Edit');
  });
});

describe('GenericACPProcess empty-turn guard', () => {
  type Internals = {
    connection: unknown;
    activeSessionId: string | null;
    runOnePrompt: (prompt: string, images?: unknown[]) => Promise<void>;
    translateUpdate: (u: unknown) => void;
  };

  function assistantTexts(messages: CLIMessage[]): string[] {
    return messages
      .filter((m) => m.type === 'assistant' && m.message.content[0]?.type === 'text')
      .map((m) => (m as { message: { content: Array<{ text: string }> } }).message.content[0].text);
  }

  test('surfaces a visible notice when the agent ends a turn with no output', async () => {
    const { proc, messages } = makeProcess();
    const internals = proc as unknown as Internals;
    // end_turn with zero session updates — the silent-success case.
    internals.connection = { prompt: async () => ({ stopReason: 'end_turn' }) };
    internals.activeSessionId = 'sess-1';

    await internals.runOnePrompt('haz varios commits y push', []);

    const texts = assistantTexts(messages);
    expect(texts).toHaveLength(1);
    expect(texts[0]).toContain('without producing any output');
    expect(texts[0]).toContain('end_turn');
  });

  test('does NOT add a notice when the turn produced real assistant text', async () => {
    const { proc, messages } = makeProcess();
    const internals = proc as unknown as Internals;
    internals.connection = {
      prompt: async () => {
        // The agent streams a real chunk (banner + answer) during the turn.
        internals.translateUpdate({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'pi v0.70.2\n---\nListo' },
        });
        return { stopReason: 'end_turn' };
      },
    };
    internals.activeSessionId = 'sess-1';

    await internals.runOnePrompt('hola', []);

    const texts = assistantTexts(messages);
    expect(texts).toEqual(['Listo']);
    expect(texts.some((t) => t.includes('without producing any output'))).toBe(false);
  });
});
