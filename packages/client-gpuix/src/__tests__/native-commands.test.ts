import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createThreadWorkspaceStore } from '@funny/client-core';

import { createNativeClientComposition } from '../platform/composition';
import type { NativeHeaders } from '../platform/transport';
import { createNativeThreadCommands } from '../services/thread-commands';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

class HeadersStub implements NativeHeaders {
  get(): string | null {
    return null;
  }
  forEach(): void {}
}

describe('native thread command transport', () => {
  test('uses existing prompt, stop, resume, and structured permission endpoints', async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const directory = mkdtempSync(join(tmpdir(), 'funny-native-commands-'));
    directories.push(directory);
    const composition = createNativeClientComposition({
      dataDirectory: directory,
      persistentSession: false,
      diagnosticSink: () => undefined,
      fetch: async (url, init) => {
        requests.push({
          path: new URL(url).pathname,
          body: init.body ? JSON.parse(init.body) : null,
        });
        return { status: 200, ok: true, headers: new HeadersStub(), text: async () => '{}' };
      },
    });
    const workspace = createThreadWorkspaceStore();
    const commands = createNativeThreadCommands({ composition, workspace });
    await commands.submitPrompt({
      threadId: 't1',
      content: 'hello',
      optimisticMessage: {
        id: 'local',
        threadId: 't1',
        role: 'user',
        content: 'hello',
        timestamp: '2026-08-23T00:00:00Z',
      },
    });
    workspace.getState().setRun('t1', { runId: 'r1', status: 'running' });
    await commands.stopRun('t1');
    await commands.resumeRun({ threadId: 't1', runId: 'r1', content: 'continue' });
    workspace.getState().setPermission('t1', {
      requestId: 'q1',
      threadId: 't1',
      runId: 'r1',
      transport: 'codex-acp',
      toolCallId: 'tc1',
      toolName: 'Bash',
      canAlwaysAllow: true,
      canDeny: true,
      requestedAt: '2026-08-23T00:00:00Z',
      status: 'active',
    });
    await commands.respondPermission({
      threadId: 't1',
      runId: 'r1',
      requestId: 'q1',
      decision: 'deny',
    });
    expect(requests.map((request) => request.path)).toEqual([
      '/api/threads/t1/message',
      '/api/threads/t1/stop',
      '/api/threads/t1/message',
      '/api/threads/t1/permission-requests/q1/respond',
    ]);
    expect(requests[0]?.body).toEqual({ content: 'hello' });
    expect(requests[3]?.body).toEqual({ decision: 'deny' });
  });
});
