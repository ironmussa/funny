/**
 * Tests for AntigravityACPProcess (Google's `agy` CLI over ACP).
 *
 * The update shapes below are copied from a real `agy acp` 1.5.14 session:
 * agy names its tools `run_command` / `read_file` / `edit_file` / `write_file`
 * and uses PascalCase arguments (`CommandLine`, `Path`).
 */

import { describe, expect, test } from 'bun:test';

import type { SessionUpdate } from '@agentclientprotocol/sdk/unstable';

import { AntigravityACPProcess } from '../agents/antigravity-acp.js';
import { extractACPAccountInfo } from '../agents/generic-acp-helpers.js';
import type { CLIMessage } from '../agents/types.js';

function makeProcess(
  overrides: Partial<ConstructorParameters<typeof AntigravityACPProcess>[0]> = {},
): { proc: AntigravityACPProcess; messages: CLIMessage[] } {
  const proc = new AntigravityACPProcess({
    prompt: 'test',
    cwd: '/tmp/test',
    model: 'default',
    ...overrides,
  });
  const messages: CLIMessage[] = [];
  proc.on('message', (m: CLIMessage) => messages.push(m));
  return { proc, messages };
}

function translate(proc: AntigravityACPProcess, update: SessionUpdate): void {
  proc['translateUpdate'](update);
}

function firstToolUse(messages: CLIMessage[]) {
  const m = messages[0];
  if (m?.type !== 'assistant') throw new Error('expected an assistant message');
  const block = m.message.content[0];
  if (block.type !== 'tool_use') throw new Error('expected a tool_use block');
  return block;
}

/** A fake ACP agent that records every request it receives. */
function fakeAgent() {
  const calls: Array<{ method: unknown; params: unknown }> = [];
  const agent = {
    request: async (method: unknown, params: unknown) => {
      calls.push({ method, params });
      return {};
    },
  };
  const methods = { agent: { session: { setMode: 'session/set_mode' } } };
  return { agent, methods, calls };
}

describe('AntigravityACPProcess spawn command', () => {
  test('launches `agy acp` without gemini-cli flags', () => {
    const { proc } = makeProcess({
      model: 'gemini-4-neon-high',
      originalPermissionMode: 'autoEdit',
    });
    const { command, args } = proc['resolveCommand']();
    expect(command).toBe('agy');
    expect(args).toEqual(['acp']);
  });

  // Google supports third-party clients only through the official `agy acp`
  // runtime talking to Google's own endpoint. Never present funny as another
  // client or point agy at another backend: that is the OAuth-shim pattern
  // that gets Google accounts suspended.
  test('never overrides the user agent or the Cloud Code endpoint', () => {
    const { proc } = makeProcess({ model: 'default' });
    const { args } = proc['resolveCommand']();
    const forbidden =
      /override_user_agent|override-user-agent|cloud_code_endpoint|cloud-code-endpoint/;
    expect(args.some((a: string) => forbidden.test(a))).toBe(false);
  });
});

describe('AntigravityACPProcess model and mode selection', () => {
  test('selects the model with session/set_model', async () => {
    const { proc } = makeProcess({ model: 'gemini-3.8-flash-low' });
    proc['activeSessionId'] = 'sess-1';
    const { agent, methods, calls } = fakeAgent();

    await proc['applyModelSelection'](agent as never, methods as never);

    expect(calls).toEqual([
      {
        method: 'session/set_model',
        params: { sessionId: 'sess-1', modelId: 'gemini-3.8-flash-low' },
      },
    ]);
  });

  test('leaves the configured default model alone', async () => {
    const { proc } = makeProcess({ model: 'default' });
    proc['activeSessionId'] = 'sess-1';
    const { agent, methods, calls } = fakeAgent();

    await proc['applyModelSelection'](agent as never, methods as never);

    expect(calls).toEqual([]);
  });

  test.each([
    ['plan', 'plan'],
    ['ask', 'default'],
    ['confirmEdit', 'default'],
    ['autoEdit', 'default'],
  ] as const)('funny %s sets agy mode %s', async (funnyMode, agyMode) => {
    const { proc } = makeProcess({ originalPermissionMode: funnyMode });
    proc['activeSessionId'] = 'sess-1';
    const { agent, methods, calls } = fakeAgent();

    await proc['applySessionMode'](agent as never, methods as never, false);

    expect(calls).toEqual([
      { method: 'session/set_mode', params: { sessionId: 'sess-1', modeId: agyMode } },
    ]);
  });

  test('autoEdit approves agy permission requests without asking the user', async () => {
    const { proc } = makeProcess({ originalPermissionMode: 'autoEdit' });
    const outcome = await proc['handleRequestPermission']({
      sessionId: 'sess-1',
      toolCall: {
        toolCallId: 'call-1',
        kind: 'execute',
        title: 'ls',
        rawInput: { CommandLine: 'ls' },
      },
      options: [
        { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
        { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
      ],
    } as never);

    expect(outcome).toEqual({ outcome: { outcome: 'selected', optionId: 'allow' } });
  });
});

describe('AntigravityACPProcess.translateUpdate', () => {
  test('run_command shows its CommandLine as the Bash command', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-ls',
      kind: 'execute',
      title: 'ls -la .',
      status: 'in_progress',
      rawInput: { CommandLine: 'ls -la .', WaitMsBeforeAsync: 5000, toolSummary: 'List directory' },
    });

    const block = firstToolUse(messages);
    expect(block.name).toBe('Bash');
    expect(block.input).toMatchObject({ command: 'ls -la .' });
  });

  test('read_file takes the file path from its Path argument', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-read',
      kind: 'read',
      title: 'File a.txt',
      status: 'in_progress',
      rawInput: { Path: '/repo/a.txt' },
    });

    const block = firstToolUse(messages);
    expect(block.name).toBe('Read');
    expect(block.input).toMatchObject({ file_path: '/repo/a.txt' });
  });

  test('edit_file renders an inline diff from the diff content block', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-edit',
      kind: 'edit',
      title: 'File a.txt',
      status: 'completed',
      locations: [{ path: '/repo/a.txt' }],
      rawInput: { Path: '/repo/a.txt', Target: 'hello world', Replacement: 'hello there' },
      rawOutput: {},
      content: [
        {
          type: 'diff',
          path: '/repo/a.txt',
          oldText: 'hello world\n',
          newText: 'hello there\n',
        },
      ],
    });

    const block = firstToolUse(messages);
    expect(block.name).toBe('Edit');
    expect(block.input).toMatchObject({
      file_path: '/repo/a.txt',
      old_string: 'hello world\n',
      new_string: 'hello there\n',
    });
  });

  test('in-progress edit_file populates old_string and new_string from Target and Replacement', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-edit-raw',
      kind: 'edit',
      title: 'File a.txt',
      status: 'in_progress',
      locations: [{ path: '/repo/a.txt' }],
      rawInput: { Path: '/repo/a.txt', Target: 'hello world', Replacement: 'hello there' },
    });

    const block = firstToolUse(messages);
    expect(block.name).toBe('Edit');
    expect(block.input).toMatchObject({
      file_path: '/repo/a.txt',
      old_string: 'hello world',
      new_string: 'hello there',
    });
  });

  test('in-progress write_file populates new_string from Content', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-write-raw',
      kind: 'edit',
      title: 'Write a.txt',
      status: 'in_progress',
      locations: [{ path: '/repo/a.txt' }],
      rawInput: { Path: '/repo/a.txt', Content: 'export const x = 1;\n', Overwrite: true },
    });

    const block = firstToolUse(messages);
    expect(block.name).toBe('Edit');
    expect(block.input).toMatchObject({
      file_path: '/repo/a.txt',
      new_string: 'export const x = 1;\n',
    });
  });

  test('defers an in-progress edit without diff text until tool_call_update delivers the diff', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-edit-deferred',
      kind: 'edit',
      title: 'File a.txt',
      status: 'in_progress',
      locations: [{ path: '/repo/a.txt' }],
      rawInput: {},
    });
    expect(messages).toHaveLength(0);

    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-edit-deferred',
      status: 'completed',
      content: [
        {
          type: 'diff',
          path: '/repo/a.txt',
          oldText: 'before\n',
          newText: '',
        },
      ],
    });

    const block = firstToolUse(messages);
    expect(block.name).toBe('Edit');
    expect(block.input).toMatchObject({
      file_path: '/repo/a.txt',
      old_string: 'before\n',
      new_string: '',
    });
  });

  test('still emits a deferred edit at completion when only file_path was provided', () => {
    const { proc, messages } = makeProcess();

    translate(proc, {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-edit-path-only',
      kind: 'edit',
      title: 'File a.txt',
      status: 'in_progress',
      locations: [{ path: '/repo/a.txt' }],
      rawInput: {},
    });
    expect(messages).toHaveLength(0);

    translate(proc, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'call-edit-path-only',
      status: 'completed',
      rawOutput: 'Edited',
    });

    const block = firstToolUse(messages);
    expect(block.name).toBe('Edit');
    expect(block.input).toMatchObject({ file_path: '/repo/a.txt' });
  });
});

describe('extractACPAccountInfo', () => {
  test('extracts nested account fields from ACP _meta', () => {
    expect(
      extractACPAccountInfo({
        account: { email: 'dev@google.com', org: 'Google', tier: 'pro' },
      }),
    ).toEqual({
      email: 'dev@google.com',
      organization: 'Google',
      subscriptionType: 'pro',
    });
  });

  test('returns null when _meta has no account fields', () => {
    expect(extractACPAccountInfo(undefined)).toBeNull();
    expect(extractACPAccountInfo({ version: '1.5.14' })).toBeNull();
  });
});
