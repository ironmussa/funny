import { afterEach, beforeEach, describe, expect, test, vi, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import type { CLIMessage } from '../agents/types.js';
import { firstContentBlock, firstTextAt } from './helpers/test-helpers.js';

const { availableModels } = (() => ({
  availableModels: [
    { provider: 'anthropic', id: 'claude-opus-4-5', name: 'Claude Opus 4.5' },
    { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT-5.5' },
  ],
}))();

mock.module('@earendil-works/pi-coding-agent', () => ({
  getAgentDir: () => '/tmp/pi-agent',
  ModelRuntime: {
    create: async () => ({
      getAvailable: async () => availableModels,
      getModels: () => availableModels,
      getModel: (provider: string, id: string) =>
        availableModels.find((m) => m.provider === provider && m.id === id),
      settleCredentialWrites: async () => {},
    }),
  },
  SettingsManager: { create: () => ({}) },
  SessionManager: {
    list: async () => [],
    create: () => ({ getSessionId: () => 'pi-session' }),
  },
  createAgentSession: vi.fn(),
}));

import {
  discoverPiModels,
  PiSDKProcess,
  resolveRequestedModel,
  resolvePiExtensionPaths,
  resolvePiTools,
} from '../agents/pi-sdk.js';

function makeProcess(): { proc: PiSDKProcess; messages: CLIMessage[] } {
  const proc = new PiSDKProcess({
    prompt: 'hello',
    cwd: '/tmp/work',
    model: 'default',
  });
  const messages: CLIMessage[] = [];
  proc.on('message', (msg) => messages.push(msg));
  return { proc, messages };
}

describe('PiSDKProcess event translation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('translates text deltas into accumulated assistant text', () => {
    const { proc, messages } = makeProcess();

    proc['handleSessionEvent']({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Hola' },
    });
    proc['handleSessionEvent']({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: ' mundo' },
    });

    expect(messages).toHaveLength(2);
    expect(firstTextAt(messages, 1)).toBe('Hola mundo');
  });

  test('translates thinking deltas into a Think tool card before text', () => {
    const { proc, messages } = makeProcess();

    proc['handleSessionEvent']({
      type: 'message_update',
      assistantMessageEvent: { type: 'thinking_delta', delta: 'Plan breve' },
    });
    proc['handleSessionEvent']({
      type: 'message_update',
      assistantMessageEvent: { type: 'text_delta', delta: 'Listo' },
    });

    expect(firstContentBlock(messages, 0)).toMatchObject({
      type: 'tool_use',
      name: 'Think',
      input: { content: 'Plan breve' },
    });
    expect(firstContentBlock(messages, 1)).toMatchObject({
      type: 'tool_result',
      content: 'Plan breve',
    });
    expect(firstTextAt(messages, 2)).toBe('Listo');
  });

  test('translates tool start/end into tool_use and tool_result', () => {
    const { proc, messages } = makeProcess();

    proc['handleSessionEvent']({
      type: 'tool_execution_start',
      toolCallId: 'tool-1',
      toolName: 'read',
      args: { path: 'README.md' },
    });
    proc['handleSessionEvent']({
      type: 'tool_execution_end',
      toolCallId: 'tool-1',
      toolName: 'read',
      result: { content: [{ type: 'text', text: 'contents' }] },
      isError: false,
    });

    expect(firstContentBlock(messages, 0)).toMatchObject({
      type: 'tool_use',
      id: 'tool-1',
      name: 'Read',
      input: { path: 'README.md', file_path: 'README.md' },
    });
    expect(firstContentBlock(messages, 1)).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: 'contents',
    });
  });

  test('normalizes codex-style shell tool calls for client tool cards', () => {
    const { proc, messages } = makeProcess();

    proc['handleSessionEvent']({
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        toolCall: {
          id: 'shell-1',
          name: 'shell',
          arguments: {
            cmd: 'sed -n "1,20p" package.json',
            cwd: '/tmp/work',
          },
        },
      },
    });

    expect(firstContentBlock(messages, 0)).toMatchObject({
      type: 'tool_use',
      id: 'shell-1',
      name: 'Bash',
      input: {
        cmd: 'sed -n "1,20p" package.json',
        command: 'sed -n "1,20p" package.json',
        cwd: '/tmp/work',
        workdir: '/tmp/work',
      },
    });
  });
});

describe('discoverPiModels', () => {
  test('returns SDK registry models and GPT-5.6 compatibility entries', async () => {
    const result = await discoverPiModels();

    expect(result).toEqual({
      ok: true,
      models: [
        { modelId: 'anthropic/claude-opus-4-5', name: 'Claude Opus 4.5' },
        { modelId: 'openai-codex/gpt-5.5', name: 'GPT-5.5' },
        { modelId: 'openai-codex/gpt-5.6-sol', name: 'GPT-5.6 Sol' },
        { modelId: 'openai-codex/gpt-5.6-terra', name: 'GPT-5.6 Terra' },
        { modelId: 'openai-codex/gpt-5.6-luna', name: 'GPT-5.6 Luna' },
      ],
      currentModelId: null,
    });
  });

  test("resolves the GPT-5.6 alias and variants through Pi's OpenAI transport", async () => {
    const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
    const registry = await ModelRuntime.create();

    expect(resolveRequestedModel(registry, 'openai-codex/gpt-5.6')).toMatchObject({
      provider: 'openai-codex',
      id: 'gpt-5.6-sol',
      contextWindow: 1_050_000,
      maxTokens: 128_000,
      thinkingLevelMap: {
        off: 'none',
        low: 'low',
        medium: 'medium',
        high: 'high',
        xhigh: 'max',
      },
      cost: { input: 5, output: 30 },
    });
    expect(resolveRequestedModel(registry, 'openai-codex/gpt-5.6-terra')).toMatchObject({
      provider: 'openai-codex',
      id: 'gpt-5.6-terra',
      cost: { input: 2.5, output: 15 },
    });
  });
});

describe('resolvePiExtensionPaths', () => {
  const original = process.env.FUNNY_PI_EXTENSION_PATHS;

  afterEach(() => {
    if (original === undefined) delete process.env.FUNNY_PI_EXTENSION_PATHS;
    else process.env.FUNNY_PI_EXTENSION_PATHS = original;
  });

  test('resolves a sibling extension directory from an ancestor of cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'funny-pi-ext-'));
    try {
      const repo = join(root, 'funny');
      const cwd = join(repo, 'packages', 'runtime');
      const extension = join(root, 'pi-harness');
      mkdirSync(cwd, { recursive: true });
      mkdirSync(extension, { recursive: true });
      writeFileSync(
        join(extension, 'package.json'),
        JSON.stringify({ pi: { extensions: ['./index.ts'] } }),
      );
      writeFileSync(join(extension, 'index.ts'), 'export default function extension() {}');
      process.env.FUNNY_PI_EXTENSION_PATHS = '../pi-harness';

      expect(resolvePiExtensionPaths(cwd)).toEqual([join(extension, 'index.ts')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('keeps explicit extension entry files unchanged after resolving them', () => {
    const root = mkdtempSync(join(tmpdir(), 'funny-pi-ext-file-'));
    try {
      const entry = join(root, 'index.ts');
      writeFileSync(entry, 'export default function extension() {}');
      process.env.FUNNY_PI_EXTENSION_PATHS = entry;

      expect(resolvePiExtensionPaths(root)).toEqual([entry]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('resolvePiTools', () => {
  test('maps Funny permission tool names to Pi and codex harness tool names', () => {
    expect(resolvePiTools(['Read', 'Bash', 'Edit', 'TodoWrite'], undefined)).toEqual([
      'read',
      'view_image',
      'bash',
      'shell',
      'shell_command',
      'exec_command',
      'write_stdin',
      'edit',
      'apply_patch',
      'update_plan',
    ]);
  });

  test('filters mapped tools when a deny-list is provided', () => {
    expect(resolvePiTools(['Read', 'Bash', 'Edit'], ['Bash', 'Edit'])).toEqual([
      'read',
      'view_image',
    ]);
  });

  test('leaves tools unspecified when no allow-list or deny-list is provided', () => {
    expect(resolvePiTools(undefined, undefined)).toBeUndefined();
    expect(resolvePiTools([], undefined)).toBeUndefined();
  });
});
