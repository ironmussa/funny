import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createNativeApplicationServices } from '../application';
import { createNativeClientComposition } from '../platform/composition';
import type { NativeHeaders } from '../platform/transport';
import type { NativeSocket } from '../services/realtime';

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

class HeadersStub implements NativeHeaders {
  constructor(private readonly cookies: string[] = []) {}
  get(): string | null {
    return null;
  }
  getSetCookie(): string[] {
    return this.cookies;
  }
  forEach(): void {}
}

class WorkflowSocket implements NativeSocket {
  connected = false;
  readonly sent: string[] = [];
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  private readonly any = new Set<(event: string, data: unknown) => void>();
  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.handlers.get(event) ?? new Set();
    listeners.add(listener);
    this.handlers.set(event, listeners);
  }
  off(event: string, listener: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(listener);
  }
  onAny(listener: (event: string, data: unknown) => void): void {
    this.any.add(listener);
  }
  offAny(listener: (event: string, data: unknown) => void): void {
    this.any.delete(listener);
  }
  emit(event: string): void {
    this.sent.push(event);
  }
  disconnect(): void {
    this.connected = false;
  }
  fire(event: string, data?: unknown): void {
    if (event === 'connect') this.connected = true;
    for (const listener of this.handlers.get(event) ?? []) listener(data);
  }
  receive(event: string, data: unknown): void {
    for (const listener of this.any) listener(event, data);
  }
}

describe('native primary workflow smoke', () => {
  test('covers login, navigation, long history, prompt, streaming, controls, permission, reconnect, and logout', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'funny-native-workflow-'));
    directories.push(directory);
    let signedIn = false;
    const mutations: string[] = [];
    const messages = Array.from({ length: 500 }, (_, index) => ({
      id: `m${index}`,
      threadId: 't1',
      role: index % 2 ? 'assistant' : 'user',
      content: `message ${index}`,
      timestamp: new Date(index * 1_000).toISOString(),
    }));
    const composition = createNativeClientComposition({
      dataDirectory: directory,
      persistentSession: false,
      diagnosticSink: () => undefined,
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        if (init.method !== 'GET') mutations.push(path);
        if (path.endsWith('/auth/sign-in/username')) {
          signedIn = true;
          return {
            status: 200,
            ok: true,
            headers: new HeadersStub(['session=abc; Path=/']),
            text: async () => '{}',
          };
        }
        let body: unknown = {};
        if (path.endsWith('/auth/get-session'))
          body = signedIn ? { user: { id: 'u1', username: 'ada', name: 'Ada' } } : null;
        else if (path === '/api/profile') body = { setupCompleted: true };
        else if (path === '/api/projects') body = [{ id: 'p1', name: 'Project' }];
        else if (path === '/api/threads')
          body = {
            threads: [{ id: 't1', projectId: 'p1', title: 'Thread', status: 'idle' }],
            total: 1,
          };
        else if (path === '/api/threads/scratch') body = { threads: [], total: 0 };
        else if (path === '/api/threads/shared-with-me') body = { threads: [] };
        else if (path === '/api/threads/t1')
          body = {
            id: 't1',
            projectId: 'p1',
            title: 'Thread',
            status: 'idle',
            messages,
            hasMore: false,
            total: 500,
          };
        return {
          status: 200,
          ok: true,
          headers: new HeadersStub(),
          text: async () => JSON.stringify(body),
        };
      },
    });
    const socket = new WorkflowSocket();
    const application = createNativeApplicationServices(composition, {
      socketFactory: () => socket,
    });
    await application.signIn('ada', 'password');
    socket.fire('connect');
    await application.data.selectThread('t1');
    expect(application.workspaceState.getState().byThreadId.t1.messageIds).toHaveLength(500);
    await application.commands.submitPrompt({
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
    socket.receive('agent:message', {
      threadId: 't1',
      data: { eventId: 'user', messageId: 'server-user', role: 'user', content: 'hello' },
    });
    socket.receive('agent:message', {
      threadId: 't1',
      data: {
        eventId: 'assistant',
        messageId: 'assistant',
        role: 'assistant',
        content: 'streamed',
      },
    });
    expect(application.workspaceState.getState().byThreadId.t1.messagesById.assistant.content).toBe(
      'streamed',
    );
    application.workspaceState.getState().setRun('t1', { runId: 'r1', status: 'running' });
    await application.commands.stopRun('t1');
    application.workspaceState.getState().setRun('t1', { runId: 'r2', status: 'waiting' });
    await application.commands.resumeRun({ threadId: 't1', runId: 'r2', content: 'continue' });
    application.workspaceState.getState().setPermission('t1', {
      requestId: 'q1',
      threadId: 't1',
      runId: 'r2',
      transport: 'codex-acp',
      toolCallId: 'tc1',
      toolName: 'Bash',
      canAlwaysAllow: true,
      canDeny: true,
      requestedAt: '2026-08-23T00:00:00Z',
      status: 'active',
    });
    await application.commands.respondPermission({
      threadId: 't1',
      runId: 'r2',
      requestId: 'q1',
      decision: 'deny',
    });
    socket.fire('disconnect', 'transport close');
    socket.fire('connect');
    await application.logout();
    expect(application.authState.getState().phase).toBe('anonymous');
    expect(mutations).toEqual([
      '/api/auth/sign-in/username',
      '/api/threads/t1/message',
      '/api/threads/t1/stop',
      '/api/threads/t1/message',
      '/api/threads/t1/permission-requests/q1/respond',
      '/api/auth/sign-out',
    ]);
  });
});
