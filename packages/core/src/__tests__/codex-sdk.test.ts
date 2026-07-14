import { execFileSync } from 'child_process';
import { chmod, mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join, relative } from 'path';

import { describe, expect, test } from 'vitest';

import {
  CodexSDKProcess,
  resolveCodexSandboxOptions,
  resolveCodexSandboxWritableDirectories,
} from '../agents/codex-sdk.js';

const options = {
  prompt: 'hello',
  cwd: '/tmp',
  model: 'gpt-5.4',
};

describe('CodexSDKProcess', () => {
  test('maps Funny permission modes to the intended Codex sandbox', () => {
    expect(resolveCodexSandboxOptions('plan')).toEqual({
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
    });
    expect(resolveCodexSandboxOptions('autoEdit')).toEqual({
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
    });
    expect(resolveCodexSandboxOptions('confirmEdit', true)).toEqual({
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      networkAccessEnabled: true,
    });
  });

  test('treats an SDK approval failure as recovery, never as a live permission request', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'funny-codex-sdk-permission-'));
    const fixtureBinary = join(fixtureDir, 'codex-fixture.mjs');
    const previousBinary = process.env.CODEX_BINARY_PATH;
    const messages: any[] = [];

    try {
      // Exercise the installed @openai/codex-sdk's real exec/JSONL protocol
      // without a network call or a user credential. Its public event union
      // has no permission request/response operation, so a permission-like
      // failure must remain an error the UI can recover from, not a fake
      // actionable approval.
      await writeFile(
        fixtureBinary,
        `#!/usr/bin/env node
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({ type: 'thread.started', thread_id: 'sdk-permission-thread' }));
  console.log(JSON.stringify({ type: 'turn.started' }));
  console.log(JSON.stringify({
    type: 'turn.failed',
    error: { message: 'Approval required before this command can run' },
  }));
});
`,
      );
      await chmod(fixtureBinary, 0o755);
      process.env.CODEX_BINARY_PATH = fixtureBinary;

      const agent = new CodexSDKProcess({ ...options, permissionMode: 'ask' });
      agent.on('message', (message) => messages.push(message));

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Codex SDK fixture timed out')), 5_000);
        agent.on('message', (message) => {
          if (message.type !== 'result') return;
          clearTimeout(timeout);
          resolve();
        });
        agent.start();
      });

      expect(agent.respondToPermission).toBeUndefined();
      expect(messages.some((message) => message.type === 'permission_request')).toBe(false);
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: 'result',
          subtype: 'error_during_execution',
          errors: ['Approval required before this command can run'],
        }),
      );
      expect(messages).toContainEqual(
        expect.objectContaining({
          type: 'assistant',
          message: expect.objectContaining({
            content: [
              expect.objectContaining({
                type: 'tool_use',
                name: 'ProviderError',
                input: { error: 'Approval required before this command can run' },
              }),
            ],
          }),
        }),
      );

      await agent.kill();
    } finally {
      if (previousBinary === undefined) delete process.env.CODEX_BINARY_PATH;
      else process.env.CODEX_BINARY_PATH = previousBinary;
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  test('allows linked-worktree Git metadata in workspace-write mode', async () => {
    const root = await mkdtemp(join(tmpdir(), 'funny-codex-worktree-'));
    const repository = join(root, 'repository');
    const worktree = join(root, 'worktree');

    try {
      await mkdir(repository);
      git(repository, ['init']);
      git(repository, ['config', 'user.name', 'Funny test']);
      git(repository, ['config', 'user.email', 'test@example.invalid']);
      await writeFile(join(repository, 'README.md'), 'initial\n');
      git(repository, ['add', 'README.md']);
      git(repository, ['commit', '-m', 'initial']);
      git(repository, ['worktree', 'add', '-b', 'codex-sandbox-test', worktree]);

      const expected = [
        gitOutput(worktree, ['rev-parse', '--path-format=absolute', '--git-dir']),
        gitOutput(worktree, ['rev-parse', '--path-format=absolute', '--git-common-dir']),
      ];

      await expect(resolveCodexSandboxWritableDirectories(worktree)).resolves.toEqual(expected);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('does not publish aggregate turn usage as context-window usage', async () => {
    const process = new CodexSDKProcess(options);
    const messages: any[] = [];
    process.on('message', (message) => messages.push(message));

    const handleEvent = (process as any).handleEvent.bind(process);
    await handleEvent({
      type: 'turn.completed',
      usage: {
        input_tokens: 186_000,
        cached_input_tokens: 180_000,
        output_tokens: 500,
        reasoning_output_tokens: 0,
      },
    });

    // Turn usage includes every model request made while Codex works. It is
    // not the current context-window size and must never drive the UI meter.
    expect(messages).toEqual([]);
  });

  test('streams changed agent-message text with one stable message ID', async () => {
    const process = new CodexSDKProcess(options);
    const messages: any[] = [];
    process.on('message', (message) => messages.push(message));

    const handleEvent = (process as any).handleEvent.bind(process);
    await handleEvent({ type: 'thread.started', thread_id: 'thread-1' });
    await handleEvent({
      type: 'item.started',
      item: { id: 'answer-1', type: 'agent_message', text: '' },
    });
    await handleEvent({
      type: 'item.updated',
      item: { id: 'answer-1', type: 'agent_message', text: 'Draft' },
    });
    await handleEvent({
      type: 'item.updated',
      item: { id: 'answer-1', type: 'agent_message', text: 'Final answer' },
    });
    const result = await handleEvent({
      type: 'item.completed',
      item: { id: 'answer-1', type: 'agent_message', text: 'Final answer' },
    });

    const assistantMessages = messages.filter((message) => message.type === 'assistant');
    // Within a turn the item ID is stable, so both updates carry the same
    // (turn-scoped) message ID — the runtime merges them into one card.
    expect(assistantMessages).toHaveLength(2);
    const ids = assistantMessages.map((m) => m.message.id);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toMatch(/:answer-1$/);
    expect(assistantMessages.every((m) => m.hasStableMessageId === true)).toBe(true);
    expect(assistantMessages.map((m) => m.message.content[0].text)).toEqual([
      'Draft',
      'Final answer',
    ]);
    expect(result).toBe('Final answer');
  });

  test('gives distinct message IDs to reused item IDs across turns', async () => {
    const process = new CodexSDKProcess(options);
    const messages: any[] = [];
    process.on('message', (message) => messages.push(message));

    const handleEvent = (process as any).handleEvent.bind(process);
    const beginTurn = (process as any).beginTurn.bind(process);

    // Turn 1 — Codex numbers its first message item ordinally.
    beginTurn();
    await handleEvent({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: 'hola de vuelta' },
    });

    // Turn 2 — Codex reuses the same ordinal item ID for a different reply.
    beginTurn();
    await handleEvent({
      type: 'item.completed',
      item: { id: 'item_0', type: 'agent_message', text: '7' },
    });

    const ids = messages.filter((m) => m.type === 'assistant').map((m) => m.message.id);
    expect(ids).toHaveLength(2);
    // Both end in the reused SDK id but differ by turn namespace, so the
    // runtime persists two rows instead of overwriting the first reply.
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toMatch(/:item_0$/);
    expect(ids[1]).toMatch(/:item_0$/);
  });

  test('normalizes Codex todo_list items to the TodoWrite checklist contract', async () => {
    const process = new CodexSDKProcess(options);
    const messages: any[] = [];
    process.on('message', (message) => messages.push(message));

    const handleEvent = (process as any).handleEvent.bind(process);
    await handleEvent({
      type: 'item.completed',
      item: {
        id: 'todos-1',
        type: 'todo_list',
        items: [
          { text: 'Inspect the thread card', completed: true },
          { text: 'Render the checklist', completed: false },
        ],
      },
    });

    const toolUseMessage = messages.find(
      (message) => message.type === 'assistant' && message.message.content[0]?.type === 'tool_use',
    );
    if (toolUseMessage?.type !== 'assistant')
      throw new Error('TodoWrite tool call was not emitted');
    expect(toolUseMessage.message.content[0]).toMatchObject({
      type: 'tool_use',
      name: 'TodoWrite',
      input: {
        todos: [
          { content: 'Inspect the thread card', status: 'completed' },
          { content: 'Render the checklist', status: 'pending' },
        ],
      },
    });
  });

  test('normalizes Codex file changes to the ACP Edit tool card contract', async () => {
    const process = new CodexSDKProcess(options);
    const messages: any[] = [];
    process.on('message', (message) => messages.push(message));

    const handleEvent = (process as any).handleEvent.bind(process);
    await handleEvent({
      type: 'item.completed',
      item: {
        id: 'file-change-1',
        type: 'file_change',
        status: 'completed',
        changes: [{ path: '/repo/src/config.ts', kind: 'update' }],
      },
    });

    const toolUseMessage = messages.find(
      (message) => message.type === 'assistant' && message.message.content[0]?.type === 'tool_use',
    );
    expect(toolUseMessage).toBeDefined();
    if (toolUseMessage.type !== 'assistant') throw new Error('unreachable');
    const toolUse = toolUseMessage.message.content[0];
    expect(toolUse).toMatchObject({
      type: 'tool_use',
      name: 'Edit',
      input: {
        changes: {
          '/repo/src/config.ts': { type: 'update' },
        },
      },
    });
  });

  test('captures a file-change patch before emitting the Edit card', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'funny-codex-file-change-'));
    try {
      git(cwd, ['init']);
      git(cwd, ['config', 'user.name', 'Funny test']);
      git(cwd, ['config', 'user.email', 'test@example.invalid']);
      const filePath = join(cwd, 'src', 'config.ts');
      await mkdir(join(cwd, 'src'));
      await writeFile(filePath, 'export const port = 3000;\n');
      git(cwd, ['add', '.']);
      git(cwd, ['commit', '-m', 'initial']);
      await writeFile(filePath, 'export const port = 5173;\n');

      const process = new CodexSDKProcess({ ...options, cwd });
      const messages: any[] = [];
      process.on('message', (message) => messages.push(message));
      const handleEvent = (process as any).handleEvent.bind(process);
      await handleEvent({
        type: 'item.completed',
        item: {
          id: 'file-change-with-diff',
          type: 'file_change',
          status: 'completed',
          changes: [{ path: filePath, kind: 'update' }],
        },
      });

      const toolUseMessage = messages.find(
        (message) =>
          message.type === 'assistant' && message.message.content[0]?.type === 'tool_use',
      );
      if (toolUseMessage?.type !== 'assistant') throw new Error('Edit tool call was not emitted');
      expect(toolUseMessage.message.content[0]).toMatchObject({
        type: 'tool_use',
        name: 'Edit',
        input: {
          changes: {
            [filePath]: {
              type: 'update',
              unified_diff: expect.stringContaining(`diff --git a/${relative(cwd, filePath)}`),
            },
          },
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test('captures a patch when Codex edits from a sibling worktree', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'funny-codex-agent-cwd-'));
    const editedRepo = await mkdtemp(join(tmpdir(), 'funny-codex-edited-repo-'));
    try {
      git(editedRepo, ['init']);
      git(editedRepo, ['config', 'user.name', 'Funny test']);
      git(editedRepo, ['config', 'user.email', 'test@example.invalid']);
      const filePath = join(editedRepo, 'config.ts');
      await writeFile(filePath, 'export const port = 3000;\n');
      git(editedRepo, ['add', '.']);
      git(editedRepo, ['commit', '-m', 'initial']);
      await writeFile(filePath, 'export const port = 5173;\n');

      const process = new CodexSDKProcess({ ...options, cwd });
      const messages: any[] = [];
      process.on('message', (message) => messages.push(message));
      const handleEvent = (process as any).handleEvent.bind(process);
      await handleEvent({
        type: 'item.completed',
        item: {
          id: 'file-change-sibling-worktree',
          type: 'file_change',
          status: 'completed',
          changes: [{ path: filePath, kind: 'update' }],
        },
      });

      const toolUseMessage = messages.find(
        (message) =>
          message.type === 'assistant' && message.message.content[0]?.type === 'tool_use',
      );
      if (toolUseMessage?.type !== 'assistant') throw new Error('Edit tool call was not emitted');
      expect(toolUseMessage.message.content[0]).toMatchObject({
        type: 'tool_use',
        name: 'Edit',
        input: {
          changes: {
            [filePath]: {
              type: 'update',
              unified_diff: expect.stringContaining('+export const port = 5173;'),
            },
          },
        },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
      await rm(editedRepo, { recursive: true, force: true });
    }
  });
});

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function gitOutput(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}
