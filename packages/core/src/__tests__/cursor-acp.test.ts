/**
 * Regression tests for CursorACPProcess.translateUpdate().
 *
 * Cursor's ACP stream has its own quirks compared to Gemini/Codex:
 *   - read_file rawOutput arrives as `{ content: "<file text>" }` (a JSON
 *     envelope, not a raw string) — the adapter must unwrap it via
 *     extractACPToolOutput so the Read card renders file contents instead of
 *     a `{"content":"…"}` blob (see thread Dj2S-mi1RLe6t9bH1JOu4).
 *   - The initial `tool_call` often has empty rawInput / locations / content;
 *     the path can only be recovered from Cursor-specific rawInput aliases
 *     (`target_file`, `abs_path`, …) or from embedded resource blocks.
 *   - Some tool_call_update events arrive without a prior tool_call — the
 *     adapter must synthesize a tool_use so the card still renders.
 *   - agent_thought_chunk text is buffered and flushed as a single Think
 *     tool_use+tool_result pair on the next non-thought event.
 */

import { describe, expect, test } from 'vitest';

import { CursorACPProcess } from '../agents/cursor-acp.js';
import type { CLIMessage } from '../agents/types.js';

function makeProcess(): { proc: CursorACPProcess; messages: CLIMessage[] } {
  const proc = new CursorACPProcess({
    prompt: 'test',
    cwd: '/tmp/test',
    model: 'default',
  });
  const messages: CLIMessage[] = [];
  proc.on('message', (m: CLIMessage) => messages.push(m));
  return { proc, messages };
}

function translate(proc: CursorACPProcess, update: unknown): void {
  // translateUpdate is private; tests reach in deliberately.
  (proc as unknown as { translateUpdate: (u: unknown) => void }).translateUpdate(update);
}

describe('CursorACPProcess.translateUpdate', () => {
  test('Read tool_call with target_file rawInput sets file_path', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'read-1',
      kind: 'read',
      title: 'Read File',
      rawInput: { target_file: '/repo/src/app.ts' },
    });

    expect(messages).toHaveLength(1);
    const m = messages[0];
    if (m.type !== 'assistant') throw new Error('unreachable');
    const block = m.message.content[0];
    expect(block).toMatchObject({ type: 'tool_use', id: 'read-1', name: 'Read' });
    if (block.type !== 'tool_use') throw new Error('unreachable');
    expect(block.input).toMatchObject({ file_path: '/repo/src/app.ts' });
  });

  test('Read tool_call completed unwraps `{ content: string }` rawOutput', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'read-2',
      kind: 'read',
      title: 'Read File',
      rawInput: { target_file: '/repo/pkg.json' },
      status: 'completed',
      rawOutput: { content: '{ "name": "x" }' },
    });

    // assistant tool_use + user tool_result
    expect(messages).toHaveLength(2);
    const result = messages[1];
    if (result.type !== 'user') throw new Error('unreachable');
    expect(result.message.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'read-2',
      content: '{ "name": "x" }',
    });
  });

  test('Read tool_call with embedded resource block recovers file_path', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'read-3',
      kind: 'read',
      title: 'Read File',
      // No rawInput, no locations — only the content block carries the path.
      content: [
        {
          type: 'content',
          content: {
            type: 'resource',
            resource: { uri: 'file:///repo/src/x.ts', text: 'export const x = 1;' },
          },
        },
      ],
    });

    const m = messages[0];
    if (m.type !== 'assistant') throw new Error('unreachable');
    const block = m.message.content[0];
    if (block.type !== 'tool_use') throw new Error('unreachable');
    expect(block.input).toMatchObject({ file_path: '/repo/src/x.ts' });
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

  test('tool_call_update without prior tool_call synthesizes a tool_use', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-orphan',
      status: 'completed',
      kind: 'edit',
      title: 'Edit File',
      rawInput: { target_file: '/repo/src/y.ts' },
      rawOutput: 'Edited 1 file',
    });

    expect(messages).toHaveLength(2);
    const first = messages[0];
    expect(first.type).toBe('assistant');
    if (first.type !== 'assistant') throw new Error('unreachable');
    const block = first.message.content[0];
    expect(block).toMatchObject({
      type: 'tool_use',
      id: 'edit-orphan',
      name: 'Edit',
    });
    if (block.type !== 'tool_use') throw new Error('unreachable');
    expect(block.input).toMatchObject({ file_path: '/repo/src/y.ts' });

    const second = messages[1];
    if (second.type !== 'user') throw new Error('unreachable');
    expect(second.message.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'edit-orphan',
      content: 'Edited 1 file',
    });
  });

  test('does not double-emit tool_use when tool_call already arrived', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'read-dup',
      kind: 'read',
      title: 'Read File',
      rawInput: { target_file: '/repo/src/dup.ts' },
    });
    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'read-dup',
      status: 'completed',
      rawOutput: { content: 'hello' },
    });

    const toolUseBlocks = messages.flatMap((m) =>
      m.type === 'assistant' ? m.message.content.filter((c) => c.type === 'tool_use') : [],
    );
    expect(toolUseBlocks).toHaveLength(1);
    expect(toolUseBlocks[0]).toMatchObject({ id: 'read-dup', name: 'Read' });

    const toolResults = messages.flatMap((m) =>
      m.type === 'user' ? m.message.content.filter((c) => c.type === 'tool_result') : [],
    );
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]).toMatchObject({ tool_use_id: 'read-dup', content: 'hello' });
  });

  test('defers tool_use until a later update supplies the read path', () => {
    // Cursor streams skeleton `pending` tool_calls (no rawInput/locations)
    // when reading many files at once, then fills the path in a later update.
    // Emitting from the empty initial event would freeze an empty card on the
    // server (input is frozen at first emission), so we must defer.
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'read-deferred',
      kind: 'read',
      title: 'Reading file',
      status: 'pending',
    });

    // Nothing emitted yet.
    expect(messages).toHaveLength(0);

    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'read-deferred',
      status: 'completed',
      locations: [{ path: '/repo/packages/client/src/foo.tsx' }],
      rawOutput: { content: '1\timport x;\n' },
    });

    const uses = messages.flatMap((m) =>
      m.type === 'assistant' ? m.message.content.filter((c) => c.type === 'tool_use') : [],
    );
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ id: 'read-deferred', name: 'Read' });
    if (uses[0].type !== 'tool_use') throw new Error('unreachable');
    expect(uses[0].input).toMatchObject({ file_path: '/repo/packages/client/src/foo.tsx' });

    const results = messages.flatMap((m) =>
      m.type === 'user' ? m.message.content.filter((c) => c.type === 'tool_result') : [],
    );
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ tool_use_id: 'read-deferred' });
  });

  test('terminal update without a resolvable path still emits a card + result', () => {
    // If the path never arrives, we must still emit the card at terminal status
    // so the tool_result has a matching tool_use (no stranded result).
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'read-nopath',
      kind: 'read',
      title: 'Reading file',
      status: 'pending',
    });
    expect(messages).toHaveLength(0);

    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'read-nopath',
      status: 'completed',
      rawOutput: 'done',
    });

    const uses = messages.flatMap((m) =>
      m.type === 'assistant' ? m.message.content.filter((c) => c.type === 'tool_use') : [],
    );
    expect(uses).toHaveLength(1);
    expect(uses[0]).toMatchObject({ id: 'read-nopath', name: 'Read' });

    const results = messages.flatMap((m) =>
      m.type === 'user' ? m.message.content.filter((c) => c.type === 'tool_result') : [],
    );
    expect(results).toHaveLength(1);
  });

  test('Edit recovers file_path + old/new string from the ACP diff content block', () => {
    // Cursor sends an empty rawInput on the initial tool_call and only reports
    // the edit via the standard ACP `diff` ToolCallContent block on completion.
    // The card needs file_path + old_string + new_string to render a diff.
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'edit-diff',
      kind: 'edit',
      title: 'Edit File',
      status: 'pending',
      rawInput: {},
    });
    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-diff',
      status: 'in_progress',
    });
    // Nothing renderable yet — deferred.
    expect(messages).toHaveLength(0);

    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'edit-diff',
      status: 'completed',
      content: [
        {
          type: 'diff',
          path: '/repo/src/sample.ts',
          oldText: 'export const a = 1;\n',
          newText: 'export const a = 1;\nexport const b = 2;\n',
        },
      ],
    });

    const uses = messages.flatMap((m) =>
      m.type === 'assistant' ? m.message.content.filter((c) => c.type === 'tool_use') : [],
    );
    expect(uses).toHaveLength(1);
    const block = uses[0];
    if (block.type !== 'tool_use') throw new Error('unreachable');
    expect(block).toMatchObject({ id: 'edit-diff', name: 'Edit' });
    expect(block.input).toMatchObject({
      file_path: '/repo/src/sample.ts',
      old_string: 'export const a = 1;\n',
      new_string: 'export const a = 1;\nexport const b = 2;\n',
    });
  });

  test('agent_thought_chunk buffers thought and flushes as Think on next event', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'planning the search' },
    });
    // No flush yet — pendingThought is still buffered.
    expect(messages).toHaveLength(0);

    // A regular agent message chunk should flush the thought first.
    translate(proc, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'starting' },
    });

    // Expect: assistant Think tool_use, user Think tool_result, then assistant text.
    expect(messages.length).toBeGreaterThanOrEqual(3);
    const thinkUse = messages[0];
    if (thinkUse.type !== 'assistant') throw new Error('unreachable');
    expect(thinkUse.message.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'Think',
      input: { content: 'planning the search' },
    });
    const thinkResult = messages[1];
    if (thinkResult.type !== 'user') throw new Error('unreachable');
    expect(thinkResult.message.content[0]).toMatchObject({
      type: 'tool_result',
      content: 'planning the search',
    });
  });

  test('agent_message_chunk accumulates streaming text under one message id', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'Hello ' },
    });
    translate(proc, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'world' },
    });

    expect(messages).toHaveLength(2);
    const m0 = messages[0];
    const m1 = messages[1];
    if (m0.type !== 'assistant' || m1.type !== 'assistant') throw new Error('unreachable');
    expect(m0.message.id).toBe(m1.message.id);
    expect(m1.message.content[0]).toMatchObject({ type: 'text', text: 'Hello world' });
  });

  test('updateTodos tool_call defers until todos arrive in tool_call_update', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'todo-1',
      title: 'Update TODOs',
      rawInput: { _toolName: 'updateTodos', description: 'Update TODOs' },
      status: 'pending',
    });

    expect(messages).toHaveLength(0);

    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'todo-1',
      title: 'Update TODOs',
      rawInput: {
        todos: [
          { id: '1', content: 'Fix CI blockers', status: 'in_progress' },
          { id: '2', content: 'Raise coverage', status: 'pending' },
        ],
        merge: true,
      },
      status: 'completed',
      rawOutput: 'Done',
    });

    expect(messages).toHaveLength(2);
    const [use, result] = messages;
    if (use.type !== 'assistant') throw new Error('unreachable');
    const block = use.message.content[0];
    expect(block).toMatchObject({ type: 'tool_use', name: 'TodoWrite' });
    if (block.type !== 'tool_use') throw new Error('unreachable');
    expect(block.input).toEqual({
      todos: [
        { content: 'Fix CI blockers', status: 'in_progress' },
        { content: 'Raise coverage', status: 'pending' },
      ],
    });
    if (result.type !== 'user') throw new Error('unreachable');
    expect(result.message.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'todo-1',
      content: 'Done',
    });
  });

  test('plan update emits a TodoWrite card from `content` fields', () => {
    const { proc, messages } = makeProcess();

    // ACP PlanEntry carries the task text in `content` (not `title`).
    translate(proc, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'Open file', status: 'completed', priority: 'high' },
        { content: 'Edit file', status: 'in_progress', priority: 'medium' },
        { content: 'Commit', status: 'pending', priority: 'low' },
      ],
    });

    expect(messages).toHaveLength(2);
    const [use, result] = messages;
    if (use.type !== 'assistant') throw new Error('unreachable');
    const block = use.message.content[0];
    expect(block).toMatchObject({ type: 'tool_use', name: 'TodoWrite' });
    if (block.type !== 'tool_use') throw new Error('unreachable');
    expect(block.input).toEqual({
      todos: [
        { content: 'Open file', status: 'completed' },
        { content: 'Edit file', status: 'in_progress' },
        { content: 'Commit', status: 'pending' },
      ],
    });

    if (result.type !== 'user') throw new Error('unreachable');
    expect(result.message.content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: block.id,
    });
  });
});
