/**
 * Regression test for GeminiACPProcess.translateUpdate().
 *
 * Bug: Gemini sometimes skips the initial `tool_call` ACP event and goes
 * straight to a `tool_call_update` with `status: 'completed'`. The old
 * adapter only emitted a `tool_result` in that case, with no `tool_use`,
 * so the client persisted a result with no matching tool card — edits
 * (`replace`, `write_file`) and some `run_shell_command` calls applied to
 * disk silently with no UI feedback.
 *
 * Fix: when the toolCallId was never seen, synthesize the `tool_use` from
 * the update's kind/title/rawInput/locations before emitting the result.
 */

import { GeminiACPProcess } from '../agents/gemini-acp.js';
import type { CLIMessage } from '../agents/types.js';

function makeProcess(): { proc: GeminiACPProcess; messages: CLIMessage[] } {
  const proc = new GeminiACPProcess({
    prompt: 'test',
    cwd: '/tmp/test',
    model: 'gemini-2.5-pro',
  });
  const messages: CLIMessage[] = [];
  proc.on('message', (m: CLIMessage) => messages.push(m));
  return { proc, messages };
}

function translate(proc: GeminiACPProcess, update: unknown): void {
  // translateUpdate is private; tests reach in deliberately.
  (proc as unknown as { translateUpdate: (u: unknown) => void }).translateUpdate(update);
}

describe('GeminiACPProcess.translateUpdate (regression)', () => {
  test('synthesizes tool_use when tool_call_update arrives with no prior tool_call (edit)', () => {
    const { proc, messages } = makeProcess();

    // Gemini skips `tool_call` and emits a completed `tool_call_update` directly.
    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'replace-1778080402143-15',
      status: 'completed',
      kind: 'edit',
      title: 'replace foo with bar in src/x.ts',
      rawInput: {
        file_path: '/repo/src/x.ts',
        old_string: 'foo',
        new_string: 'bar',
      },
      locations: [{ path: '/repo/src/x.ts' }],
      rawOutput: 'Edited 1 file',
    });

    expect(messages).toHaveLength(2);

    // First: synthetic assistant tool_use so the client can render the card.
    const first = messages[0];
    expect(first.type).toBe('assistant');
    if (first.type !== 'assistant') throw new Error('unreachable');
    const block = first.message.content[0];
    expect(block).toMatchObject({
      type: 'tool_use',
      id: 'replace-1778080402143-15',
      name: 'Edit',
    });
    if (block.type !== 'tool_use') throw new Error('unreachable');
    expect(block.input).toMatchObject({
      file_path: '/repo/src/x.ts',
      old_string: 'foo',
      new_string: 'bar',
    });

    // Second: user tool_result wired to the synthetic tool_use id.
    const second = messages[1];
    expect(second.type).toBe('user');
    if (second.type !== 'user') throw new Error('unreachable');
    expect(second.message.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'replace-1778080402143-15',
      content: 'Edited 1 file',
    });
  });

  test('synthesizes tool_use when tool_call_update arrives with no prior tool_call (execute)', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'run_shell_command-1778080100000-3',
      status: 'completed',
      kind: 'execute',
      title: 'git status',
      rawInput: { command: 'git status' },
      rawOutput: 'On branch master\n',
    });

    expect(messages).toHaveLength(2);
    const first = messages[0];
    expect(first.type).toBe('assistant');
    if (first.type !== 'assistant') throw new Error('unreachable');
    const block = first.message.content[0];
    expect(block).toMatchObject({
      type: 'tool_use',
      id: 'run_shell_command-1778080100000-3',
      name: 'Bash',
    });
    if (block.type !== 'tool_use') throw new Error('unreachable');
    expect(block.input).toMatchObject({ command: 'git status' });

    expect(messages[1].type).toBe('user');
  });

  test('does not double-emit tool_use when tool_call already arrived', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'read_file-1',
      kind: 'read',
      title: 'read packages/core/src/agents/gemini-acp.ts',
      rawInput: { file_path: '/repo/packages/core/src/agents/gemini-acp.ts' },
      locations: [{ path: '/repo/packages/core/src/agents/gemini-acp.ts' }],
    });
    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'read_file-1',
      status: 'completed',
      rawOutput: '...file contents...',
    });

    const toolUseBlocks = messages.flatMap((m) =>
      m.type === 'assistant' ? m.message.content.filter((c) => c.type === 'tool_use') : [],
    );
    expect(toolUseBlocks).toHaveLength(1);
    expect(toolUseBlocks[0]).toMatchObject({ id: 'read_file-1', name: 'Read' });

    const toolResults = messages.flatMap((m) =>
      m.type === 'user' ? m.message.content.filter((c) => c.type === 'tool_result') : [],
    );
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({ tool_use_id: 'read_file-1' });
  });

  test('preamble tool_call followed by tool_call_update is still suppressed', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'preamble-1',
      title: '[current working directory /repo] (Check git status before editing)',
    });
    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'preamble-1',
      status: 'completed',
      rawOutput: 'ok',
    });

    // Preamble must not produce a tool_use/tool_result pair; it's collapsed
    // into the pendingThought buffer instead.
    const toolUses = messages.flatMap((m) =>
      m.type === 'assistant' ? m.message.content.filter((c) => c.type === 'tool_use') : [],
    );
    expect(toolUses).toHaveLength(0);
  });
});
