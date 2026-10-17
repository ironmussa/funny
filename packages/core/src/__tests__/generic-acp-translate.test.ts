/**
 * Quirk-driven branches of GenericACPProcess.translateUpdate() that the
 * per-provider suites (cursor / gemini / opencode) do not exercise: text plan
 * rendering, glued-message splitting, banner stripping, slash-command updates,
 * non-synthesizing orphan updates, preamble buffering and history replay.
 */

import type { ProviderManifest, QuirkFlags } from '@funny/shared/provider-manifest';
import { geminiManifest } from '@funny/shared/provider-manifests';
import { describe, expect, test } from 'vitest';

import { GenericACPProcess } from '../agents/generic-acp.js';
import type { CLIMessage } from '../agents/types.js';

function makeProcess(quirks: QuirkFlags): { proc: GenericACPProcess; messages: CLIMessage[] } {
  const manifest: ProviderManifest = { ...geminiManifest, quirks };
  const proc = new GenericACPProcess(
    { prompt: 'test', cwd: '/tmp/test', model: 'default' },
    manifest,
  );
  const messages: CLIMessage[] = [];
  proc.on('message', (m: CLIMessage) => messages.push(m));
  return { proc, messages };
}

function translate(proc: GenericACPProcess, update: unknown): void {
  (proc as unknown as { translateUpdate: (u: unknown) => void }).translateUpdate(update);
}

function blocks(messages: CLIMessage[]): any[] {
  return messages.flatMap((m) => ((m as any).message?.content ?? []) as any[]);
}

describe('GenericACPProcess.translateUpdate quirks', () => {
  test('planRender text emits a **Plan:** checklist and closes in-flight Task calls', () => {
    const { proc, messages } = makeProcess({ planRender: 'text' });
    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'task-1',
      kind: 'switch_mode',
      title: 'Planning',
    });
    translate(proc, {
      sessionUpdate: 'plan',
      entries: [
        { content: 'one', status: 'completed' },
        { title: 'two', status: 'in_progress' },
        { status: 'pending' },
      ],
    });

    const all = blocks(messages);
    const expected = '[x] 1. one\n[~] 2. two\n[ ] 3. Task';
    expect(all).toContainEqual({ type: 'tool_result', tool_use_id: 'task-1', content: expected });
    expect(all).toContainEqual({ type: 'text', text: `**Plan:**\n${expected}` });
  });

  test('planRender text with no entries emits nothing', () => {
    const { proc, messages } = makeProcess({ planRender: 'text' });
    translate(proc, { sessionUpdate: 'plan', entries: [] });
    expect(messages).toHaveLength(0);
  });

  test('planRender todoCard emits TodoWrite + Plan updated result', () => {
    const { proc, messages } = makeProcess({ planRender: 'todoCard' });
    translate(proc, {
      sessionUpdate: 'plan',
      entries: [{ content: 'a', status: 'in_progress', priority: 'high' }],
    });
    const all = blocks(messages);
    expect(all[0]).toMatchObject({
      type: 'tool_use',
      name: 'TodoWrite',
      input: { todos: [{ content: 'a', status: 'in_progress' }] },
    });
    expect(all[1]).toMatchObject({ type: 'tool_result', content: 'Plan updated' });
  });

  test('splitGluedAgentMessages inserts a paragraph break only at the glue signature', () => {
    const { proc, messages } = makeProcess({ splitGluedAgentMessages: true });
    for (const text of ['Done.', 'Next', ' step.', ' more']) {
      translate(proc, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
    }
    const last = blocks(messages).at(-1);
    expect(last).toEqual({ type: 'text', text: 'Done.\n\nNext step. more' });
  });

  test('without splitGluedAgentMessages chunks are concatenated verbatim', () => {
    const { proc, messages } = makeProcess({});
    translate(proc, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'A.' },
    });
    translate(proc, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'B' } });
    expect(blocks(messages).at(-1)).toEqual({ type: 'text', text: 'A.B' });
  });

  test('stripFirstMessageBanner hides a banner-only chunk and strips it afterwards', () => {
    const { proc, messages } = makeProcess({ stripFirstMessageBanner: '^BANNER\\s*' });
    translate(proc, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'BANNER ' },
    });
    expect(messages).toHaveLength(0);
    translate(proc, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hi' },
    });
    expect(blocks(messages)).toEqual([{ type: 'text', text: 'hi' }]);
  });

  test('non-text message chunks are ignored', () => {
    const { proc, messages } = makeProcess({});
    translate(proc, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'image', data: '', mimeType: 'image/png' },
    });
    translate(proc, {
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'image', data: '', mimeType: 'image/png' },
    });
    expect(messages).toHaveLength(0);
  });

  test('available_commands_update emits commands_changed with valid names only', () => {
    const { proc, messages } = makeProcess({});
    translate(proc, {
      sessionUpdate: 'available_commands_update',
      availableCommands: [{ name: 'review' }, { name: '' }, {}, { name: 'init' }],
    });
    expect(messages).toEqual([
      { type: 'commands_changed', commands: ['review', 'init'], sessionId: '' },
    ]);
  });

  test('orphan terminal update without synth quirk emits only a tool_result', () => {
    const { proc, messages } = makeProcess({});
    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'x-1',
      status: 'completed',
      rawOutput: 'out',
    });
    expect(blocks(messages)).toEqual([{ type: 'tool_result', tool_use_id: 'x-1', content: 'out' }]);
  });

  test('orphan non-terminal update without synth quirk emits nothing', () => {
    const { proc, messages } = makeProcess({});
    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'x-2',
      status: 'in_progress',
    });
    expect(messages).toHaveLength(0);
  });

  test('preamble tool_calls collapse into one Think card; their completions are swallowed', () => {
    const { proc, messages } = makeProcess({ bufferPreambleAsThink: true });
    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'p-1',
      title: '[current working directory /repo] (Check status)',
    });
    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'p-2',
      title: '[current working directory /repo] (Then diff)',
    });
    translate(proc, { sessionUpdate: 'tool_call_update', toolCallId: 'p-1', status: 'completed' });
    expect(messages).toHaveLength(0);

    translate(proc, {
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'ok' },
    });
    const all = blocks(messages);
    expect(all[0]).toMatchObject({
      type: 'tool_use',
      name: 'Think',
      input: { content: 'Check status\nThen diff' },
    });
    expect(all.at(-1)).toEqual({ type: 'text', text: 'ok' });
  });

  test('preamble titles are regular tool calls without the quirk', () => {
    const { proc, messages } = makeProcess({});
    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'p-1',
      kind: 'execute',
      title: '[current working directory /repo] (Check status)',
    });
    expect(blocks(messages)[0]).toMatchObject({ type: 'tool_use', name: 'Bash' });
  });

  test('completed tool_call emits tool_use then tool_result in one go', () => {
    const { proc, messages } = makeProcess({});
    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'b-1',
      kind: 'execute',
      title: 'ls',
      status: 'failed',
      rawOutput: 'boom',
    });
    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'b-1',
      kind: 'execute',
      title: 'ls',
    });
    const all = blocks(messages);
    expect(all).toHaveLength(2);
    expect(all[0]).toMatchObject({ type: 'tool_use', id: 'b-1', input: { command: 'ls' } });
    expect(all[1]).toEqual({ type: 'tool_result', tool_use_id: 'b-1', content: 'boom' });
  });

  test('updates are ignored while replaying history', () => {
    const { proc, messages } = makeProcess({});
    (proc as unknown as { replayingHistory: boolean }).replayingHistory = true;
    translate(proc, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'x' } });
    expect(messages).toHaveLength(0);
  });
});
