import { describe, expect, test } from 'bun:test';

import type { PendingPermissionRequest, ToolCall } from '@funny/shared';

import {
  createThreadWorkspaceStore,
  MAX_RETAINED_THREAD_MESSAGES,
} from '../stores/thread-workspace';

const msg = (id: string, content = id) => ({
  id,
  threadId: 't1',
  role: 'assistant' as const,
  content,
  timestamp: `2026-08-23T00:00:0${id}.000Z`,
});
const tool = (id: string, messageId = 'm1'): ToolCall => ({
  id,
  messageId,
  name: 'Read',
  input: '{}',
});
const request = (requestId = 'q1'): PendingPermissionRequest => ({
  requestId,
  threadId: 't1',
  runId: 'r1',
  transport: 'codex-acp',
  toolCallId: 'tc1',
  toolName: 'Bash',
  canAlwaysAllow: true,
  canDeny: true,
  requestedAt: '2026-08-23T00:00:00.000Z',
});

describe('portable thread workspace merges', () => {
  test('normalizes initial messages and tool calls with canonical identities', () => {
    const store = createThreadWorkspaceStore();
    store.getState().replaceInitialPage('t1', {
      messages: [{ ...msg('m1'), toolCalls: [tool('tc1')] }, msg('m2')],
      hasMore: true,
      total: 10,
      windowStart: 8,
    });
    const data = store.getState().byThreadId.t1;
    expect(data.messageIds).toEqual(['m1', 'm2']);
    expect(data.toolCallIdsByMessage.m1).toEqual(['tc1']);
    expect(data.toolCallsById.tc1.name).toBe('Read');
    expect(data).toMatchObject({ hasMore: true, total: 10, windowStart: 8 });
  });

  test('prepends older pages without duplicate or reordered existing rows', () => {
    const store = createThreadWorkspaceStore();
    store.getState().replaceInitialPage('t1', { messages: [msg('m3'), msg('m4')], hasMore: true });
    store.getState().prependOlderPage('t1', {
      messages: [msg('m1'), msg('m2'), msg('m3')],
      hasMore: false,
    });
    expect(store.getState().byThreadId.t1.messageIds).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  test('updates stable streaming rows and rejects duplicate or late revisions', () => {
    const store = createThreadWorkspaceStore();
    expect(
      store.getState().applyStreamingDelta({
        eventId: 'e1',
        threadId: 't1',
        messageId: 'm1',
        revision: 1,
        content: 'Hello',
      }),
    ).toBe(true);
    expect(
      store.getState().applyStreamingDelta({
        eventId: 'e2',
        threadId: 't1',
        messageId: 'm1',
        revision: 2,
        content: ' world',
      }),
    ).toBe(true);
    expect(
      store.getState().applyStreamingDelta({
        eventId: 'e2',
        threadId: 't1',
        messageId: 'm1',
        revision: 3,
        content: ' duplicate',
      }),
    ).toBe(false);
    expect(
      store.getState().applyStreamingDelta({
        eventId: 'late',
        threadId: 't1',
        messageId: 'm1',
        revision: 1,
        content: ' late',
      }),
    ).toBe(false);
    expect(store.getState().byThreadId.t1.messagesById.m1).toMatchObject({
      content: 'Hello world',
      delivery: 'streaming',
    });
  });

  test('merges durable messages, tool output, runs, and permission lifecycle', () => {
    const store = createThreadWorkspaceStore();
    store.getState().upsertDurableMessage('t1', msg('m1', 'done'));
    store.getState().upsertToolCall('t1', tool('tc1'));
    store.getState().updateToolOutput('t1', 'tc1', 'result');
    store.getState().setRun('t1', { runId: 'r1', status: 'waiting' });
    store.getState().setPermission('t1', { ...request(), status: 'active' });
    expect(store.getState().resolvePermission('t1', 'wrong', 'deny')).toBe(false);
    expect(store.getState().resolvePermission('t1', 'q1', 'allow_once')).toBe(true);
    expect(store.getState().resolvePermission('t1', 'q1', 'deny')).toBe(false);
    expect(store.getState().byThreadId.t1).toMatchObject({
      toolCallsById: { tc1: { output: 'result' } },
      run: { runId: 'r1', status: 'waiting' },
      permission: { requestId: 'q1', status: 'resolved', decision: 'allow_once' },
    });
  });

  test('reconciles optimistic user identity and bounds retained history', () => {
    const store = createThreadWorkspaceStore();
    store.getState().upsertDurableMessage('t1', {
      ...msg('local', 'same prompt'),
      role: 'user',
      delivery: 'optimistic',
    });
    store.getState().upsertDurableMessage('t1', {
      ...msg('server', 'same prompt'),
      role: 'user',
    });
    expect(store.getState().byThreadId.t1.messageIds).toEqual(['server']);
    const messages = Array.from({ length: MAX_RETAINED_THREAD_MESSAGES + 5 }, (_, index) => ({
      ...msg(`bulk-${index}`),
      timestamp: new Date(index).toISOString(),
    }));
    store.getState().replaceInitialPage('bulk', { messages, hasMore: false });
    const retained = store.getState().byThreadId.bulk;
    expect(retained.messageIds).toHaveLength(MAX_RETAINED_THREAD_MESSAGES);
    expect(retained.messageIds[0]).toBe('bulk-5');
    expect(Object.keys(retained.messagesById)).toHaveLength(MAX_RETAINED_THREAD_MESSAGES);
  });
});
