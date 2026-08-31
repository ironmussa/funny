import { describe, expect, test } from 'bun:test';

import type { Message } from '@funny/shared';

import { createThreadCommandController, type ThreadCommandPorts } from '../stores/thread-commands';
import { createThreadWorkspaceStore } from '../stores/thread-workspace';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

const message = (id: string, content = id): Message => ({
  id,
  threadId: 't1',
  role: 'user',
  content,
  timestamp: '2026-08-23T00:00:00.000Z',
});

function setup(overrides: Partial<ThreadCommandPorts> = {}) {
  const store = createThreadWorkspaceStore();
  const ports: ThreadCommandPorts = {
    submitPrompt: async (input) => message('server', input.content),
    stopRun: async () => {},
    resumeRun: async () => undefined,
    respondPermission: async () => {},
    ...overrides,
  };
  return { store, controller: createThreadCommandController({ store, ports }) };
}

describe('portable thread commands', () => {
  test('prevents duplicate prompt submission and reconciles server identity', async () => {
    const request = deferred<Message>();
    const { store, controller } = setup({ submitPrompt: () => request.promise });
    const input = {
      threadId: 't1',
      content: 'hello',
      optimisticMessage: message('local', 'hello'),
    };
    const first = controller.submitPrompt(input);
    expect(controller.isPromptPending('t1')).toBe(true);
    expect(await controller.submitPrompt(input)).toBe(false);
    request.resolve(message('server', 'hello'));
    expect(await first).toBe(true);
    expect(store.getState().byThreadId.t1.messageIds).toEqual(['server']);
    expect(store.getState().byThreadId.t1.messagesById.server.delivery).toBe('confirmed');
  });

  test('marks failed optimistic messages and permits a later retry', async () => {
    let fail = true;
    const { store, controller } = setup({
      submitPrompt: async () => {
        if (fail) throw new Error('offline');
        return message('server');
      },
    });
    const input = { threadId: 't1', content: 'hello', optimisticMessage: message('local') };
    expect(await controller.submitPrompt(input)).toBe(false);
    expect(store.getState().byThreadId.t1.messagesById.local.delivery).toBe('failed');
    fail = false;
    expect(await controller.submitPrompt(input)).toBe(true);
  });

  test('keeps an acknowledged optimistic row until realtime supplies durable identity', async () => {
    const { store, controller } = setup({ submitPrompt: async () => undefined });
    const input = {
      threadId: 't1',
      content: 'hello',
      optimisticMessage: message('local', 'hello'),
    };
    expect(await controller.submitPrompt(input)).toBe(true);
    expect(store.getState().byThreadId.t1.messagesById.local.delivery).toBe('optimistic');
    store.getState().upsertDurableMessage('t1', message('server', 'hello'));
    expect(store.getState().byThreadId.t1.messageIds).toEqual(['server']);
  });

  test('single-flights stop and resume without mutating received output', async () => {
    const stop = deferred<void>();
    const resume = deferred<Message | void>();
    const { store, controller } = setup({
      stopRun: () => stop.promise,
      resumeRun: () => resume.promise,
    });
    store.getState().upsertDurableMessage('t1', message('existing', 'kept'));
    store.getState().setRun('t1', { runId: 'r1', status: 'running' });
    const stopping = controller.stopRun('t1');
    expect(await controller.stopRun('t1')).toBe(false);
    stop.resolve();
    expect(await stopping).toBe(true);
    const resuming = controller.resumeRun({ threadId: 't1', runId: 'r1', content: 'continue' });
    expect(await controller.resumeRun({ threadId: 't1', runId: 'r1', content: 'again' })).toBe(
      false,
    );
    resume.resolve(message('resume'));
    expect(await resuming).toBe(true);
    expect(store.getState().byThreadId.t1.messagesById.existing.content).toBe('kept');
  });

  test('responds once to the current run/request identity and leaves stale requests inert', async () => {
    let calls = 0;
    const response = deferred<void>();
    const { store, controller } = setup({
      respondPermission: () => {
        calls += 1;
        return response.promise;
      },
    });
    store.getState().setPermission('t1', {
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
    expect(
      await controller.respondPermission({
        threadId: 't1',
        runId: 'wrong',
        requestId: 'q1',
        decision: 'deny',
      }),
    ).toBe(false);
    const first = controller.respondPermission({
      threadId: 't1',
      runId: 'r1',
      requestId: 'q1',
      decision: 'allow_once',
    });
    expect(
      await controller.respondPermission({
        threadId: 't1',
        runId: 'r1',
        requestId: 'q1',
        decision: 'deny',
      }),
    ).toBe(false);
    response.resolve();
    expect(await first).toBe(true);
    expect(calls).toBe(1);
    expect(
      await controller.respondPermission({
        threadId: 't1',
        runId: 'r1',
        requestId: 'q1',
        decision: 'deny',
      }),
    ).toBe(false);
  });
});
