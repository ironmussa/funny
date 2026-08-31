import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createThreadNavigationStore, createThreadWorkspaceStore } from '@funny/client-core';

import { createNativeGitStatusStore } from '../git-status-state';
import { createNativeClientComposition } from '../platform/composition';
import type { NativeHeaders } from '../platform/transport';
import { NativeRealtimeService, type NativeSocket } from '../services/realtime';
import { createNativeRealtimeActions } from '../services/realtime-actions';

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

class SocketStub implements NativeSocket {
  connected = false;
  readonly sent: Array<[string, unknown]> = [];
  private readonly handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  private readonly anyHandlers = new Set<(event: string, data: unknown) => void>();
  on(event: string, listener: (...args: unknown[]) => void): void {
    const listeners = this.handlers.get(event) ?? new Set();
    listeners.add(listener);
    this.handlers.set(event, listeners);
  }
  off(event: string, listener: (...args: unknown[]) => void): void {
    this.handlers.get(event)?.delete(listener);
  }
  onAny(listener: (event: string, data: unknown) => void): void {
    this.anyHandlers.add(listener);
  }
  offAny(listener: (event: string, data: unknown) => void): void {
    this.anyHandlers.delete(listener);
  }
  emit(event: string, data: unknown): void {
    this.sent.push([event, data]);
  }
  disconnect(): void {
    this.connected = false;
  }
  fire(event: string, data?: unknown): void {
    if (event === 'connect') this.connected = true;
    for (const listener of this.handlers.get(event) ?? []) listener(data);
  }
  receive(event: string, data: unknown): void {
    for (const listener of this.anyHandlers) listener(event, data);
  }
  listenerCount(): number {
    return (
      this.anyHandlers.size +
      [...this.handlers.values()].reduce((sum, value) => sum + value.size, 0)
    );
  }
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'funny-native-realtime-'));
  directories.push(directory);
  const composition = createNativeClientComposition({
    dataDirectory: directory,
    persistentSession: false,
    diagnosticSink: () => undefined,
    fetch: async () => ({
      status: 200,
      ok: true,
      headers: new HeadersStub(),
      text: async () => '{}',
    }),
  });
  composition.cookies.capture(new HeadersStub(['funny.session=abc; Path=/; HttpOnly']));
  const workspace = createThreadWorkspaceStore();
  const navigation = createThreadNavigationStore();
  const gitStatus = createNativeGitStatusStore();
  const socket = new SocketStub();
  let reconnects = 0;
  let focusRefreshes = 0;
  const service = new NativeRealtimeService({
    platform: composition.platform,
    cookies: composition.cookies,
    actions: createNativeRealtimeActions({
      workspace,
      navigation,
      gitStatus,
      diagnostics: composition.platform.diagnostics,
    }),
    effects: { emit: () => undefined },
    clientOrigin: composition.clientOrigin,
    socketFactory: () => socket,
    refreshForFocus: () => {
      focusRefreshes += 1;
    },
    refreshForReconnect: () => {
      reconnects += 1;
    },
    onSessionRejected: () => undefined,
    clock: (() => {
      let now = 10_000;
      return () => (now += 3_000);
    })(),
  });
  return {
    composition,
    workspace,
    navigation,
    gitStatus,
    socket,
    service,
    counts: () => ({ reconnects, focusRefreshes }),
  };
}

describe('native realtime', () => {
  test('connects with the authenticated session, dispatches events, and resyncs', () => {
    const { composition, workspace, socket, service, counts } = setup();
    composition.navigation.navigate({ pathname: '/projects/p1/threads/t1', search: '', hash: '' });
    expect(service.connect()).toBe(true);
    socket.fire('connect');
    expect(service.current().phase).toBe('connected');
    expect(socket.sent).toContainEqual(['thread:open', { threadId: 't1' }]);
    socket.receive('agent:message', {
      threadId: 't1',
      data: { eventId: 'e1', messageId: 'm1', role: 'assistant', content: 'hello' },
    });
    socket.receive('agent:message', {
      threadId: 't1',
      data: { eventId: 'e1', messageId: 'm1', role: 'assistant', content: 'duplicate' },
    });
    expect(workspace.getState().byThreadId.t1.messagesById.m1.content).toBe('hello');
    socket.fire('disconnect', 'transport close');
    socket.fire('connect');
    expect(counts().reconnects).toBe(1);
    composition.lifecycle.update({ focused: false });
    composition.lifecycle.update({ focused: true });
    expect(counts().focusRefreshes).toBe(1);
  });

  test('protects terminal runs and resolved permissions from stale events', () => {
    const { workspace, socket, service } = setup();
    service.connect();
    socket.receive('agent:status', { threadId: 't1', data: { runId: 'r1', status: 'completed' } });
    socket.receive('agent:status', { threadId: 't1', data: { runId: 'r1', status: 'running' } });
    expect(workspace.getState().byThreadId.t1.run.status).toBe('completed');
    const permission = {
      requestId: 'q1',
      threadId: 't1',
      runId: 'r1',
      toolCallId: 'tc1',
      toolName: 'Bash',
      requestedAt: '2026-08-23T00:00:00Z',
      canAlwaysAllow: true,
      canDeny: true,
    };
    socket.receive('agent:status', {
      threadId: 't1',
      data: { status: 'waiting', pendingPermissionRequest: permission },
    });
    workspace.getState().resolvePermission('t1', 'q1', 'deny');
    socket.receive('agent:status', {
      threadId: 't1',
      data: { status: 'waiting', pendingPermissionRequest: permission },
    });
    expect(workspace.getState().byThreadId.t1.permission?.status).toBe('resolved');
  });

  test('publishes fresh git diff stats from realtime events', () => {
    const { gitStatus, socket, service } = setup();
    service.connect();
    socket.receive('git:status', {
      threadId: 't1',
      data: {
        statuses: [
          {
            threadId: 't1',
            branchKey: 'project:p1:branch:main',
            state: 'dirty',
            dirtyFileCount: 3,
            unpushedCommitCount: 0,
            unpulledCommitCount: 0,
            hasRemoteBranch: true,
            isMergedIntoBase: false,
            linesAdded: 24,
            linesDeleted: 7,
          },
          { threadId: 'invalid' },
        ],
      },
    });
    expect(gitStatus.getState().byThreadId.t1).toMatchObject({
      dirtyFileCount: 3,
      linesAdded: 24,
      linesDeleted: 7,
    });
    expect(gitStatus.getState().byThreadId.invalid).toBeUndefined();
  });

  test('changes active rooms and disposes every registered listener', () => {
    const { composition, socket, service } = setup();
    service.connect();
    socket.fire('connect');
    composition.navigation.navigate({ pathname: '/scratch/t1', search: '', hash: '' });
    composition.navigation.navigate({ pathname: '/scratch/t2', search: '', hash: '' });
    expect(socket.sent).toContainEqual(['thread:close', { threadId: 't1' }]);
    expect(socket.sent).toContainEqual(['thread:open', { threadId: 't2' }]);
    expect(socket.listenerCount()).toBeGreaterThan(0);
    service.disconnect();
    expect(socket.listenerCount()).toBe(0);
  });
});
