import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, test, afterEach, vi } from 'vitest';

import {
  importExternalClaudeSession,
  isClaudeCodeProcess,
  listExternalClaudeSessions,
  parsePsOutput,
  readExternalClaudeTranscript,
  syncExternalClaudeSessionThreads,
} from '../../services/external-claude-sessions.js';
import { resetServices, setServices } from '../../services/service-registry.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  resetServices();
});

function makeHome() {
  const dir = join(tmpdir(), `funny-claude-sessions-${Date.now()}-${Math.random()}`);
  mkdirSync(dir, { recursive: true });
  tempDirs.push(dir);
  return dir;
}

function writeClaudeLog(homeDir: string, cwd: string, sessionId: string) {
  const projectDir = join(homeDir, '.claude/projects', cwd.replace(/[\\/]/g, '-'));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(
    join(projectDir, `${sessionId}.jsonl`),
    [
      JSON.stringify({
        type: 'assistant',
        sessionId,
        cwd,
        gitBranch: 'feature/external',
        timestamp: '2026-06-23T12:00:00.000Z',
      }),
      JSON.stringify({
        type: 'last-prompt',
        sessionId,
        lastPrompt: 'continue the refactor',
      }),
    ].join('\n'),
  );
}

describe('external Claude sessions', () => {
  test('parses ps output with elapsed time', () => {
    expect(parsePsOutput('123 1 1-02:03:04 claude claude --dangerously-skip-permissions')).toEqual([
      {
        pid: 123,
        ppid: 1,
        elapsedSeconds: 93784,
        command: 'claude',
        args: 'claude --dangerously-skip-permissions',
      },
    ]);
  });

  test('detects Claude Code processes', () => {
    expect(isClaudeCodeProcess({ command: 'claude', args: 'claude' })).toBe(true);
    expect(
      isClaudeCodeProcess({
        command: 'node',
        args: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      }),
    ).toBe(true);
    expect(isClaudeCodeProcess({ command: 'node', args: 'node server.js' })).toBe(false);
  });

  test('excludes Claude processes managed by the current Funny runtime', () => {
    const sessions = listExternalClaudeSessions({
      currentPid: 10,
      psOutput: [
        '10 1 00:10:00 bun bun packages/runtime/dist/index.js',
        '20 10 00:05:00 claude claude --print',
        '30 1 00:02:00 claude claude',
      ].join('\n'),
      getCwd: (pid) => (pid === 30 ? '/repo' : '/repo/.funny-worktrees/thread'),
    });

    expect(sessions.map((session) => session.pid)).toEqual([30]);
  });

  test('enriches external processes with Claude project metadata', () => {
    const homeDir = makeHome();
    const cwd = '/work/funny';
    writeClaudeLog(homeDir, cwd, 'session-123');

    const sessions = listExternalClaudeSessions({
      homeDir,
      currentPid: 999,
      now: new Date('2026-06-23T12:10:00.000Z'),
      psOutput: '42 1 00:10:00 claude claude',
      getCwd: () => cwd,
    });

    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: 'claude:session-123',
      pid: 42,
      sessionId: 'session-123',
      cwd,
      projectName: 'funny',
      gitBranch: 'feature/external',
      lastPrompt: 'continue the refactor',
      startedAt: '2026-06-23T12:00:00.000Z',
      updatedAt: '2026-06-23T12:00:00.000Z',
    });
  });

  test('syncs project Claude sessions as normal empty thread shells', async () => {
    const homeDir = makeHome();
    const cwd = '/work/funny';
    writeClaudeLog(homeDir, cwd, 'session-shell');
    const createThread = vi.fn(async (_thread: Record<string, any>) => undefined);
    const insertMessage = vi.fn(async () => 'message-1');
    const emitToUser = vi.fn();

    setServices({
      projects: {
        listProjects: vi.fn(async () => [{ id: 'project-1', name: 'funny', path: cwd }]),
      },
      threads: {
        getThreadByExternalRequestId: vi.fn(async () => undefined),
        getThreadBySessionId: vi.fn(async () => undefined),
        createThread,
        insertMessage,
      },
      wsBroker: { emitToUser },
    } as any);

    const result = await syncExternalClaudeSessionThreads(
      { userId: 'user-1', projectId: 'project-1' },
      { homeDir, currentPid: 999, psOutput: '' },
    );

    const createdThread = createThread.mock.calls[0]?.[0];
    if (!createdThread) throw new Error('expected createThread to be called');
    expect(result.threadIds).toEqual([createdThread.id]);
    expect(createdThread).toMatchObject({
      projectId: 'project-1',
      userId: 'user-1',
      title: 'continue the refactor',
      provider: 'claude',
      source: 'ingest',
      createdBy: 'external',
      sessionId: 'session-shell',
      externalRequestId: 'claude:session-shell',
    });
    expect(insertMessage).not.toHaveBeenCalled();
    expect(emitToUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        type: 'thread:created',
        threadId: createdThread.id,
      }),
    );
  });

  test('hydrates an existing external Claude shell without creating a second thread', async () => {
    const homeDir = makeHome();
    const cwd = '/work/funny';
    const sessionId = 'session-hydrate';
    const projectDir = join(homeDir, '.claude/projects', cwd.replace(/[\\/]/g, '-'));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          sessionId,
          cwd,
          timestamp: '2026-06-23T12:00:00.000Z',
          message: { role: 'user', content: 'como estas?' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId,
          cwd,
          timestamp: '2026-06-23T12:01:00.000Z',
          message: { role: 'assistant', content: 'bien' },
        }),
      ].join('\n'),
    );

    const shell = {
      id: 'thread-shell',
      projectId: 'project-1',
      userId: 'user-1',
      createdAt: '2026-06-23T12:00:00.000Z',
      sessionId,
      externalRequestId: `claude:${sessionId}`,
    };
    const createThread = vi.fn(async () => undefined);
    const insertMessage = vi
      .fn()
      .mockResolvedValueOnce('message-user')
      .mockResolvedValueOnce('message-assistant');

    setServices({
      projects: {
        listProjects: vi.fn(async () => [{ id: 'project-1', name: 'funny', path: cwd }]),
      },
      threads: {
        getThreadByExternalRequestId: vi.fn(async () => shell),
        getThreadBySessionId: vi.fn(async () => undefined),
        getThreadWithMessages: vi.fn(async () => ({ ...shell, messages: [] })),
        createThread,
        insertMessage,
        insertToolCall: vi.fn(async () => 'tool-call-1'),
        updateToolCallOutput: vi.fn(async () => undefined),
      },
      wsBroker: { emitToUser: vi.fn() },
    } as any);

    const result = await importExternalClaudeSession(
      { sessionId, userId: 'user-1', projectId: 'project-1' },
      { homeDir },
    );

    expect(result).toEqual({ ok: true, imported: true, thread: shell });
    expect(createThread).not.toHaveBeenCalled();
    expect(insertMessage).toHaveBeenCalledTimes(2);
    expect(insertMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        threadId: 'thread-shell',
        role: 'user',
        content: 'como estas?',
        author: null,
      }),
    );
    expect(insertMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        threadId: 'thread-shell',
        role: 'assistant',
        content: 'bien',
        author: 'Claude Code',
      }),
    );
  });

  test('reads a Claude JSONL transcript without importing it as a thread', () => {
    const homeDir = makeHome();
    const cwd = '/work/funny';
    const sessionId = 'session-456';
    const projectDir = join(homeDir, '.claude/projects', cwd.replace(/[\\/]/g, '-'));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'summary',
          sessionId,
          cwd,
          gitBranch: 'feature/external',
          timestamp: '2026-06-23T12:00:00.000Z',
          summary: 'Session summary',
        }),
        JSON.stringify({
          type: 'user',
          sessionId,
          timestamp: '2026-06-23T12:01:00.000Z',
          message: { role: 'user', content: 'inspect the sidebar' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId,
          timestamp: '2026-06-23T12:02:00.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'The sidebar lists external sessions.' }],
          },
        }),
        JSON.stringify({
          type: 'user',
          sessionId,
          timestamp: '2026-06-23T12:03:00.000Z',
          message: {
            role: 'user',
            content: [{ type: 'tool_result', content: 'command output' }],
          },
        }),
      ].join('\n'),
    );

    const transcript = readExternalClaudeTranscript(sessionId, { homeDir });

    expect(transcript).toMatchObject({
      sessionId,
      cwd,
      projectName: 'funny',
      gitBranch: 'feature/external',
      title: 'inspect the sidebar',
      startedAt: '2026-06-23T12:00:00.000Z',
      updatedAt: '2026-06-23T12:03:00.000Z',
    });
    expect(transcript?.messages.map((message) => [message.role, message.content])).toEqual([
      ['system', 'Session summary'],
      ['user', 'inspect the sidebar'],
      ['assistant', 'The sidebar lists external sessions.'],
      ['assistant', ''],
    ]);
    expect(transcript?.messages[3]?.toolCalls).toEqual([
      {
        id: 'tool-result-3-tool-0',
        name: 'ToolResult',
        input: '{}',
        output: 'command output',
        timestamp: '2026-06-23T12:03:00.000Z',
        author: 'Claude Code',
      },
    ]);
  });

  test('omits internal thinking blocks from text and extracts tool_use cards', () => {
    const homeDir = makeHome();
    const cwd = '/work/funny';
    const sessionId = 'session-thinking';
    const projectDir = join(homeDir, '.claude/projects', cwd.replace(/[\\/]/g, '-'));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'assistant',
          sessionId,
          cwd,
          timestamp: '2026-06-23T12:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Visible response' },
              {
                type: 'thinking',
                thinking: 'private chain of thought',
                signature: 'secret',
              },
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'Read',
                input: { file_path: '.env' },
              },
              { type: 'redacted_thinking', data: 'redacted' },
            ],
          },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId,
          cwd,
          timestamp: '2026-06-23T12:01:00.000Z',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'thinking',
                thinking: 'private-only block',
                signature: 'secret',
              },
              {
                type: 'tool_use',
                id: 'tool-2',
                name: 'Bash',
                input: { command: 'pwd' },
              },
            ],
          },
        }),
      ].join('\n'),
    );

    const transcript = readExternalClaudeTranscript(sessionId, { homeDir });

    expect(transcript?.messages.map((message) => [message.role, message.content])).toEqual([
      ['assistant', 'Visible response'],
      ['assistant', ''],
    ]);
    expect(transcript?.messages[0]?.toolCalls).toEqual([
      {
        id: 'tool-1',
        name: 'Read',
        input: '{\n  "file_path": ".env"\n}',
        timestamp: '2026-06-23T12:00:00.000Z',
        author: 'Claude Code',
      },
    ]);
    expect(transcript?.messages[1]?.toolCalls).toEqual([
      {
        id: 'tool-2',
        name: 'Bash',
        input: '{\n  "command": "pwd"\n}',
        timestamp: '2026-06-23T12:01:00.000Z',
        author: 'Claude Code',
      },
    ]);
  });

  test('strips IDE opened-file markers from user-visible transcript text', () => {
    const homeDir = makeHome();
    const cwd = '/work/funny';
    const sessionId = 'session-ide-marker';
    const projectDir = join(homeDir, '.claude/projects', cwd.replace(/[\\/]/g, '-'));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'user',
          sessionId,
          cwd,
          timestamp: '2026-06-23T12:00:00.000Z',
          message: {
            role: 'user',
            content:
              '<ide_opened_file>{"path":"packages/client/src/App.tsx"}</ide_opened_file>\n\nContinue this change',
          },
        }),
        JSON.stringify({
          type: 'user',
          sessionId,
          cwd,
          timestamp: '2026-06-23T12:01:00.000Z',
          message: {
            role: 'user',
            content: '<ide_opened_file>{"path":"README.md"}</ide_opened_file>',
          },
        }),
      ].join('\n'),
    );

    const transcript = readExternalClaudeTranscript(sessionId, { homeDir });

    expect(transcript?.title).toBe('Continue this change');
    expect(transcript?.messages.map((message) => message.content)).toEqual([
      'Continue this change',
    ]);
  });

  test('attaches tool_result output to the matching tool_use card', () => {
    const homeDir = makeHome();
    const cwd = '/work/funny';
    const sessionId = 'session-tool-result';
    const projectDir = join(homeDir, '.claude/projects', cwd.replace(/[\\/]/g, '-'));
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, `${sessionId}.jsonl`),
      [
        JSON.stringify({
          type: 'assistant',
          sessionId,
          cwd,
          timestamp: '2026-06-23T12:00:00.000Z',
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Reading the file.' },
              {
                type: 'tool_use',
                id: 'tool-read-1',
                name: 'Read',
                input: { file_path: 'README.md' },
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'user',
          sessionId,
          cwd,
          timestamp: '2026-06-23T12:00:01.000Z',
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-read-1',
                content: 'README contents',
              },
            ],
          },
        }),
      ].join('\n'),
    );

    const transcript = readExternalClaudeTranscript(sessionId, { homeDir });

    expect(transcript?.messages.map((message) => [message.role, message.content])).toEqual([
      ['assistant', 'Reading the file.'],
    ]);
    expect(transcript?.messages[0]?.toolCalls).toEqual([
      {
        id: 'tool-read-1',
        name: 'Read',
        input: '{\n  "file_path": "README.md"\n}',
        output: 'README contents',
        timestamp: '2026-06-23T12:00:00.000Z',
        author: 'Claude Code',
      },
    ]);
  });
});
