/**
 * Regression tests for CodexACPProcess.translateUpdate().
 *
 * Codex-specific behaviors covered:
 *   - "Preamble" tool_calls — titles like
 *     `[current working directory /repo] (Check git status…)` are routed into
 *     the pending-Think buffer (not emitted as broken tool cards). The
 *     matching tool_call_update with status=completed must NOT emit a stray
 *     tool_result.
 *   - agent_thought_chunk buffers reasoning text and flushes as a Think
 *     tool_use+tool_result pair on the next non-thought event.
 *   - Plan updates close out any in-flight Task tool_calls with the rendered
 *     plan text before emitting the user-visible plan message.
 *   - Unlike Cursor/Gemini, an orphan tool_call_update (no prior tool_call)
 *     only emits a tool_result — codex never synthesizes a tool_use.
 */

import { describe, expect, test } from 'vitest';

import { CodexACPProcess } from '../agents/codex-acp.js';
import type { CLIMessage } from '../agents/types.js';

function makeProcess(): { proc: CodexACPProcess; messages: CLIMessage[] } {
  const proc = new CodexACPProcess({
    prompt: 'test',
    cwd: '/tmp/test',
    model: 'gpt-5.4',
  });
  const messages: CLIMessage[] = [];
  proc.on('message', (m: CLIMessage) => messages.push(m));
  return { proc, messages };
}

function translate(proc: CodexACPProcess, update: unknown): void {
  (proc as unknown as { translateUpdate: (u: unknown) => void }).translateUpdate(update);
}

describe('CodexACPProcess.translateUpdate', () => {
  test('execute tool_call routes to Bash with command', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'exec-1',
      kind: 'execute',
      title: 'git status',
      rawInput: { command: 'git status' },
    });

    expect(messages).toHaveLength(1);
    const m = messages[0];
    if (m.type !== 'assistant') throw new Error('unreachable');
    const block = m.message.content[0];
    expect(block).toMatchObject({ type: 'tool_use', id: 'exec-1', name: 'Bash' });
    if (block.type !== 'tool_use') throw new Error('unreachable');
    expect(block.input).toMatchObject({ command: 'git status' });
  });

  test('completed tool_call emits both tool_use and tool_result', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'read-1',
      kind: 'read',
      title: 'read src/foo.ts',
      rawInput: { file_path: '/repo/src/foo.ts' },
      locations: [{ path: '/repo/src/foo.ts' }],
      status: 'completed',
      rawOutput: 'file contents',
    });

    expect(messages).toHaveLength(2);
    const tr = messages[1];
    if (tr.type !== 'user') throw new Error('unreachable');
    expect(tr.message.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'read-1',
      content: 'file contents',
    });
  });

  test('preamble tool_call is buffered as Think, not emitted as a tool card', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'preamble-1',
      title: '[current working directory /repo] (Check git status before editing)',
    });
    // Matching completed update must be ignored — no tool_result for the preamble.
    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'preamble-1',
      status: 'completed',
      rawOutput: 'ok',
    });

    // No messages yet — Think text is still pending.
    expect(messages).toHaveLength(0);

    // A subsequent non-thought event flushes the buffered Think.
    translate(proc, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'done' },
    });

    // Expected sequence: Think tool_use, Think tool_result, assistant text.
    expect(messages.length).toBeGreaterThanOrEqual(3);
    const thinkUse = messages[0];
    if (thinkUse.type !== 'assistant') throw new Error('unreachable');
    expect(thinkUse.message.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'Think',
      input: { content: 'Check git status before editing' },
    });
  });

  test('agent_thought_chunk accumulates across chunks before flush', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'Step 1: ' },
    });
    translate(proc, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'check the repo' },
    });
    expect(messages).toHaveLength(0);

    // Plan triggers flushPendingThought.
    translate(proc, {
      sessionUpdate: 'plan',
      entries: [{ title: 'Inspect files', status: 'in_progress' }],
    });

    const thinkUse = messages[0];
    if (thinkUse.type !== 'assistant') throw new Error('unreachable');
    expect(thinkUse.message.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'Think',
      input: { content: 'Step 1: check the repo' },
    });
  });

  test('orphan tool_call_update only emits tool_result (no synthetic tool_use)', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'orphan-1',
      status: 'completed',
      kind: 'read',
      title: 'read foo',
      rawInput: { file_path: '/repo/foo' },
      rawOutput: 'contents',
    });

    // Codex differs from Cursor/Gemini here: just a tool_result, no synthesized tool_use.
    expect(messages).toHaveLength(1);
    const m = messages[0];
    expect(m.type).toBe('user');
    if (m.type !== 'user') throw new Error('unreachable');
    expect(m.message.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'orphan-1',
      content: 'contents',
    });
  });

  test('plan completes in-flight Task tool calls with the plan text', () => {
    const { proc, messages } = makeProcess();

    // Task tool_call starts (mode=switch_mode → Task).
    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'task-1',
      kind: 'switch_mode',
      title: 'plan mode',
      rawInput: {},
    });
    expect(messages).toHaveLength(1);

    translate(proc, {
      sessionUpdate: 'plan',
      entries: [
        { title: 'Investigate', status: 'completed' },
        { title: 'Patch', status: 'pending' },
      ],
    });

    // Locate the tool_result for task-1 closing it out.
    const taskResult = messages.find(
      (m) =>
        m.type === 'user' &&
        m.message.content.some((c) => c.type === 'tool_result' && c.tool_use_id === 'task-1'),
    );
    expect(taskResult).toBeDefined();
    if (!taskResult || taskResult.type !== 'user') throw new Error('unreachable');
    const block = taskResult.message.content[0];
    if (block.type !== 'tool_result') throw new Error('unreachable');
    expect(block.content).toContain('[x] 1. Investigate');
    expect(block.content).toContain('[ ] 2. Patch');
  });

  test('agent_message_chunk accumulates streaming text under one id', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'foo ' },
    });
    translate(proc, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'bar' },
    });

    expect(messages).toHaveLength(2);
    const m0 = messages[0];
    const m1 = messages[1];
    if (m0.type !== 'assistant' || m1.type !== 'assistant') throw new Error('unreachable');
    expect(m0.message.id).toBe(m1.message.id);
    expect(m1.message.content[0]).toMatchObject({ type: 'text', text: 'foo bar' });
  });
});

/**
 * Regression: ACP SDK 0.26 removed the dedicated `unstable_setSessionModel`
 * method (it was `undefined` on the connection → "is not a function"), so the
 * model was never applied. The model is now a `category: 'model'` session
 * config option set via `setSessionConfigOption`.
 */
describe('CodexACPProcess.applyModelSelection', () => {
  type Internal = {
    activeSessionId: string | null;
    captureModelConfigOption: (c: unknown) => void;
    applyModelSelection: (c: unknown) => Promise<void>;
  };

  test('applies the model via setSessionConfigOption when the agent advertises a model option', async () => {
    const proc = new CodexACPProcess({ prompt: 'x', cwd: '/tmp/test', model: 'gpt-5.5' });
    const internal = proc as unknown as Internal;
    internal.activeSessionId = 'sess-1';
    internal.captureModelConfigOption([
      {
        id: 'model',
        category: 'model',
        type: 'select',
        name: 'Model',
        options: [
          { value: 'gpt-5.5', name: 'GPT-5.5' },
          { value: 'gpt-5.4', name: 'GPT-5.4' },
        ],
      },
    ]);

    const calls: Array<Record<string, unknown>> = [];
    const conn = {
      setSessionConfigOption: async (p: Record<string, unknown>) => {
        calls.push(p);
      },
      // unstable_setSessionModel intentionally absent — removed in SDK 0.26.
    };
    await internal.applyModelSelection(conn);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      sessionId: 'sess-1',
      configId: 'model',
      value: { value: 'gpt-5.5' },
    });
  });

  test('skips setSessionConfigOption when the requested model is not offered', async () => {
    const proc = new CodexACPProcess({ prompt: 'x', cwd: '/tmp/test', model: 'gpt-9.9' });
    const internal = proc as unknown as Internal;
    internal.activeSessionId = 'sess-1';
    internal.captureModelConfigOption([
      {
        id: 'model',
        category: 'model',
        type: 'select',
        name: 'Model',
        options: [{ value: 'gpt-5.5', name: 'GPT-5.5' }],
      },
    ]);

    let called = false;
    await internal.applyModelSelection({
      setSessionConfigOption: async () => {
        called = true;
      },
    });
    expect(called).toBe(false);
  });

  test('resolves without throwing when the connection exposes no model-selection method', async () => {
    const proc = new CodexACPProcess({ prompt: 'x', cwd: '/tmp/test', model: 'gpt-5.5' });
    const internal = proc as unknown as Internal;
    internal.activeSessionId = 'sess-1';
    // No configOptions captured and a bare connection: must resolve, not throw.
    await expect(internal.applyModelSelection({})).resolves.toBeUndefined();
  });
});
