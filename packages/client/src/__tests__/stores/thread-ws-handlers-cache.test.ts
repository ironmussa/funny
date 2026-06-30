/**
 * Regression: WS handlers must invalidate the data-actor cache for the
 * affected thread **even when it is the currently active thread**.
 *
 * Bug: when an event arrived for the active thread, the cache snapshot held
 * by the data actor was left intact. Switching away and back resolved from
 * that stale snapshot, so a completed thread looked unfinished until refresh.
 *
 * Each handler is exercised with `activeThread.id === threadId` and the spy
 * on `invalidateThreadData` must fire.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const { mockInvalidate, mockBuffer } = vi.hoisted(() => ({
  mockInvalidate: vi.fn(),
  mockBuffer: vi.fn(),
}));

vi.mock('@/stores/thread-machine-bridge', () => ({
  invalidateThreadData: mockInvalidate,
  // Echo back the data status so tests can drive transitions directly.
  transitionThreadStatus: vi.fn(
    (_id: string, evt: { status?: string }, current: string) => evt.status ?? current,
  ),
  wsEventToMachineEvent: vi.fn((_kind: string, data: any) => ({
    type: 'SET_STATUS',
    status: data.status,
  })),
}));

vi.mock('@/stores/thread-read-store', () => ({
  useThreadReadStore: { getState: () => ({ markRead: vi.fn() }) },
}));

vi.mock('@/stores/thread-store-internals', () => ({
  bufferWSEvent: mockBuffer,
  getNavigate: vi.fn(),
  getProjectIdForThread: vi.fn(() => null),
  // null → routing gates fall back to the passed state's selectedThreadId.
  getUrlThreadId: () => null,
  setUrlThreadId: vi.fn(),
}));

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

vi.mock('@/lib/context-usage-events', () => ({ emitContextUsage: vi.fn() }));

const {
  handleWSMessage,
  handleWSToolCall,
  handleWSToolOutput,
  handleWSStatus,
  handleWSResult,
  handleWSCompactBoundary,
  handleWSQueueUpdate,
  handleWSInit,
} = await import('@/stores/thread-ws-handlers');

const THREAD_ID = 'thread-active';

function makeState(overrides: Record<string, unknown> = {}) {
  const activeThread = {
    id: THREAD_ID,
    projectId: 'p1',
    title: 't',
    status: 'running',
    cost: 0,
    messages: [],
  };
  return {
    threadsById: { [THREAD_ID]: activeThread },
    threadIdsByProject: { p1: [THREAD_ID] },
    scratchThreadIds: [],
    threadTotalByProject: { p1: 1 },
    scratchThreadTotal: 0,
    selectedThreadId: THREAD_ID,
    threadDataById: { [THREAD_ID]: activeThread },
    activeThread,
    setupProgressByThread: {},
    contextUsageByThread: {},
    queuedCountByThread: {},
    queuedMessagesByThread: {},
    queuedNextMessageByThread: {},
    loadThreadsForProject: vi.fn(),
    ...overrides,
  } as any;
}

function makeGetSet(state: any) {
  const get = () => state;
  const set = (partial: any) => {
    const next = typeof partial === 'function' ? partial(state) : partial;
    Object.assign(state, next);
  };
  return { get, set };
}

describe('thread-ws-handlers — cache invalidation for the active thread', () => {
  beforeEach(() => {
    mockInvalidate.mockClear();
    mockBuffer.mockClear();
  });

  test('buffers events when thread is selected but not yet hydrated', () => {
    const state = makeState({
      selectedThreadId: THREAD_ID,
      threadDataById: {},
      activeThread: { ...makeState().activeThread, status: 'running' },
    });
    const { get, set } = makeGetSet(state);

    handleWSMessage(get, set, THREAD_ID, { role: 'assistant', content: 'buffered' });

    expect(mockBuffer).toHaveBeenCalledWith(
      THREAD_ID,
      'message',
      expect.objectContaining({ content: 'buffered' }),
    );
    expect(state.threadDataById[THREAD_ID]).toBeUndefined();
  });

  test('updates sidebar snippet for assistant messages on unknown hydrated payload', () => {
    const otherId = 'thread-sidebar-only';
    const otherThread = {
      id: otherId,
      projectId: 'p1',
      title: 'Side',
      status: 'running',
      cost: 0,
      messages: [],
    };
    const state = makeState({
      selectedThreadId: null,
      activeThread: null,
      threadsById: { [otherId]: otherThread },
      threadIdsByProject: { p1: [otherId] },
      threadDataById: {},
    });
    const { get, set } = makeGetSet(state);

    handleWSMessage(get, set, otherId, {
      role: 'assistant',
      content: 'x'.repeat(200),
    });

    expect(state.threadsById[otherId].lastAssistantMessage).toHaveLength(120);
  });

  test('handleWSInit patches initInfo into hydrated thread payload', () => {
    const initInfo = { model: 'claude-sonnet-4-6', permissionMode: 'autoEdit' };
    const state = makeState();
    const { get, set } = makeGetSet(state);

    handleWSInit(get, set, THREAD_ID, initInfo as any);

    expect(state.threadDataById[THREAD_ID].initInfo).toEqual(initInfo);
  });

  test('handleWSStatus mirrors status onto activeThread via patchThread', () => {
    const state = makeState({
      activeThread: { ...makeState().activeThread, status: 'idle' },
    });
    state.threadsById[THREAD_ID].status = 'idle';
    state.threadDataById[THREAD_ID].status = 'idle';
    const { get, set } = makeGetSet(state);

    handleWSStatus(get, set, THREAD_ID, { status: 'running' });

    expect(state.activeThread.status).toBe('running');
    expect(state.threadsById[THREAD_ID].status).toBe('running');
    expect(state.threadDataById[THREAD_ID].status).toBe('running');
  });

  test('handleWSMessage invalidates when thread is active', () => {
    const { get, set } = makeGetSet(makeState());
    handleWSMessage(get, set, THREAD_ID, { role: 'assistant', content: 'hi' });
    expect(mockInvalidate).toHaveBeenCalledWith(THREAD_ID);
  });

  test('handleWSMessage reconciles a real user message with the optimistic tail', () => {
    const userContent = 'please consolidate the PR identifiers';
    const optimisticMessage = {
      id: 'optimistic-user-id',
      threadId: THREAD_ID,
      role: 'user',
      content: userContent,
      timestamp: '2026-01-01T00:00:00.000Z',
      model: 'gpt-5.5',
      permissionMode: 'autoEdit',
    };
    const state = makeState({
      threadDataById: {
        [THREAD_ID]: {
          ...makeState().activeThread,
          messages: [optimisticMessage],
          lastUserMessage: optimisticMessage,
        },
      },
    });
    const { get, set } = makeGetSet(state);

    handleWSMessage(get, set, THREAD_ID, {
      messageId: 'real-user-id',
      role: 'user',
      content: userContent,
    });

    const messages = state.threadDataById[THREAD_ID].messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      id: 'real-user-id',
      role: 'user',
      content: userContent,
      model: 'gpt-5.5',
      permissionMode: 'autoEdit',
    });
    expect(state.threadDataById[THREAD_ID].lastUserMessage.id).toBe('real-user-id');
  });

  test('handleWSToolCall invalidates when thread is active', () => {
    const { get, set } = makeGetSet(makeState());
    handleWSToolCall(get, set, THREAD_ID, { name: 'Bash', input: {} });
    expect(mockInvalidate).toHaveBeenCalledWith(THREAD_ID);
  });

  test('handleWSToolOutput invalidates when thread is active', () => {
    const { get, set } = makeGetSet(makeState());
    handleWSToolOutput(get, set, THREAD_ID, { toolCallId: 'tc1', output: 'ok' });
    expect(mockInvalidate).toHaveBeenCalledWith(THREAD_ID);
  });

  test('handleWSStatus invalidates when thread is active', () => {
    const { get, set } = makeGetSet(makeState());
    handleWSStatus(get, set, THREAD_ID, { status: 'running' });
    expect(mockInvalidate).toHaveBeenCalledWith(THREAD_ID);
  });

  test('handleWSResult invalidates when thread is active', () => {
    const { get, set } = makeGetSet(makeState());
    handleWSResult(get, set, THREAD_ID, { status: 'completed', cost: 0, duration: 1 });
    expect(mockInvalidate).toHaveBeenCalledWith(THREAD_ID);
  });

  test('handleWSStatus updates a scratch thread via threadsById', () => {
    const scratchThread = {
      id: 'scratch-1',
      projectId: '',
      isScratch: true,
      title: 'hola',
      status: 'idle',
      cost: 0,
      messages: [],
    };
    const state = makeState({
      activeThread: null,
      selectedThreadId: null,
      threadsById: { 'scratch-1': scratchThread },
      threadIdsByProject: {},
      scratchThreadIds: ['scratch-1'],
      threadDataById: {},
    });
    const { get, set } = makeGetSet(state);

    handleWSStatus(get, set, 'scratch-1', { status: 'running' });

    expect(state.threadsById['scratch-1'].status).toBe('running');
  });

  test('handleWSMessage updates lastAssistantMessage on a scratch thread', () => {
    const scratchThread = {
      id: 'scratch-3',
      projectId: '',
      isScratch: true,
      title: 'hola',
      status: 'running',
      cost: 0,
      messages: [],
      lastAssistantMessage: '¡Hola que te puedo ayudar...',
    };
    const state = makeState({
      activeThread: null,
      selectedThreadId: null,
      threadsById: { 'scratch-3': scratchThread },
      threadIdsByProject: {},
      scratchThreadIds: ['scratch-3'],
      threadDataById: {},
    });
    const { get, set } = makeGetSet(state);

    handleWSMessage(get, set, 'scratch-3', {
      role: 'assistant',
      content: 'La capital de Francia es París.',
    });

    expect(state.threadsById['scratch-3'].lastAssistantMessage).toBe(
      'La capital de Francia es París.',
    );
  });

  test('handleWSCompactBoundary resets contextUsage so the ring-3 updates', () => {
    const usageBefore = {
      cumulativeInputTokens: 175_000,
      lastInputTokens: 5_000,
      lastOutputTokens: 1_200,
    };
    const state = makeState({
      contextUsageByThread: { [THREAD_ID]: usageBefore },
      threadDataById: {
        [THREAD_ID]: { ...makeState().activeThread, contextUsage: usageBefore },
      },
    });
    const { get, set } = makeGetSet(state);

    handleWSCompactBoundary(get, set, THREAD_ID, {
      trigger: 'manual',
      preTokens: 175_000,
      timestamp: new Date().toISOString(),
    });

    expect(state.contextUsageByThread[THREAD_ID].cumulativeInputTokens).toBe(0);
    expect(state.threadDataById[THREAD_ID].contextUsage.cumulativeInputTokens).toBe(0);
    expect(state.threadDataById[THREAD_ID].compactionEvents).toHaveLength(1);
  });

  test('handleWSCompactBoundary uses postTokens when the SDK reports it', () => {
    const usageBefore = {
      cumulativeInputTokens: 175_000,
      lastInputTokens: 5_000,
      lastOutputTokens: 1_200,
    };
    const state = makeState({
      contextUsageByThread: { [THREAD_ID]: usageBefore },
      threadDataById: {
        [THREAD_ID]: { ...makeState().activeThread, contextUsage: usageBefore },
      },
    });
    const { get, set } = makeGetSet(state);

    handleWSCompactBoundary(get, set, THREAD_ID, {
      trigger: 'manual',
      preTokens: 175_000,
      postTokens: 32_000,
      timestamp: new Date().toISOString(),
    });

    // The ring should drop to the real post-compaction size, not freeze at the
    // pre-compaction value and not vanish to 0.
    expect(state.contextUsageByThread[THREAD_ID].cumulativeInputTokens).toBe(32_000);
    expect(state.threadDataById[THREAD_ID].contextUsage.cumulativeInputTokens).toBe(32_000);
  });

  test('handleWSMessage does NOT duplicate user msg already present in payload tail', () => {
    // Regression: bug 4 — visual duplicate of the dequeued message.
    // The server `startAgent` path inserts the user message into the DB, so
    // a thread refresh may already have it in the payload tail. The buffer
    // injection MUST tail-check by content to avoid rendering it twice.
    const userContent = 'Also PAR-007 and PAR-008';
    const state = makeState({
      threadDataById: {
        [THREAD_ID]: {
          ...makeState().activeThread,
          messages: [
            // Server-loaded user message (e.g. from DB refresh) — already shows
            // the dequeued content.
            { id: 'm-user', role: 'user', content: userContent, threadId: THREAD_ID },
          ],
        },
      },
    });
    const { get, set } = makeGetSet(state);

    // Queue update arrives with the dequeued content (server emits this AFTER
    // it inserts to DB, so a refresh may have already pulled in the message).
    handleWSQueueUpdate(get, set, THREAD_ID, {
      threadId: THREAD_ID,
      queuedCount: 0,
      dequeuedMessage: userContent,
    });

    // Agent emits its assistant response.
    handleWSMessage(get, set, THREAD_ID, {
      messageId: 'm-asst',
      role: 'assistant',
      content: 'Let me run those tests.',
    });

    const msgs = state.threadDataById[THREAD_ID].messages;
    const userMsgs = msgs.filter((m: any) => m.role === 'user' && m.content === userContent);
    expect(userMsgs).toHaveLength(1);
  });

  test('handleWSMessage consumes buffer when refreshed assistant already follows user msg', () => {
    const userContent = 'Also PAR-007 and PAR-008';
    const state = makeState({
      threadDataById: {
        [THREAD_ID]: {
          ...makeState().activeThread,
          messages: [
            { id: 'm-user', role: 'user', content: userContent, threadId: THREAD_ID },
            {
              id: 'm-asst',
              role: 'assistant',
              content: '',
              threadId: THREAD_ID,
              toolCalls: [],
            },
          ],
        },
      },
    });
    const { get, set } = makeGetSet(state);

    handleWSQueueUpdate(get, set, THREAD_ID, {
      threadId: THREAD_ID,
      queuedCount: 0,
      dequeuedMessage: userContent,
    });

    handleWSMessage(get, set, THREAD_ID, {
      messageId: 'm-asst',
      role: 'assistant',
      content: 'Let me run those tests.',
    });

    handleWSResult(get, set, THREAD_ID, { status: 'failed', cost: 0, duration: 1 });

    const msgs = state.threadDataById[THREAD_ID].messages;
    const userMsgs = msgs.filter((m: any) => m.role === 'user' && m.content === userContent);
    expect(userMsgs).toHaveLength(1);
  });

  test('handleWSMessage does NOT inject buffer when incoming role is user', () => {
    // Regression: bug 4 — when the agent:message event is itself a user
    // message (ingest-mapper / external sources), the buffer injection used
    // to fire and produce a second user message right next to it.
    const userContent = 'Also PAR-007 and PAR-008';
    const state = makeState();
    const { get, set } = makeGetSet(state);

    handleWSQueueUpdate(get, set, THREAD_ID, {
      threadId: THREAD_ID,
      queuedCount: 0,
      dequeuedMessage: userContent,
    });

    handleWSMessage(get, set, THREAD_ID, {
      role: 'user',
      content: userContent,
    });

    const msgs = state.threadDataById[THREAD_ID].messages;
    const userMsgs = msgs.filter((m: any) => m.role === 'user' && m.content === userContent);
    expect(userMsgs).toHaveLength(1);
  });

  test('handleWSResult orphan flush deduplicates against existing tail user msg', () => {
    // Regression: bug 4 — orphan flush must also dedupe by content. If the
    // user message is already in the payload (e.g. from a DB refresh that
    // raced with the failed agent run), flushing again would duplicate.
    const userContent = 'Also PAR-007 and PAR-008';
    const state = makeState({
      threadDataById: {
        [THREAD_ID]: {
          ...makeState().activeThread,
          messages: [{ id: 'm-user', role: 'user', content: userContent, threadId: THREAD_ID }],
        },
      },
    });
    const { get, set } = makeGetSet(state);

    handleWSQueueUpdate(get, set, THREAD_ID, {
      threadId: THREAD_ID,
      queuedCount: 0,
      dequeuedMessage: userContent,
    });

    handleWSResult(get, set, THREAD_ID, { status: 'failed', cost: 0, duration: 1 });

    const msgs = state.threadDataById[THREAD_ID].messages;
    const userMsgs = msgs.filter((m: any) => m.role === 'user' && m.content === userContent);
    expect(userMsgs).toHaveLength(1);
  });

  test('handleWSResult orphan flush deduplicates when assistant scaffold follows user msg', () => {
    // Regression: queued follow-up dequeue can insert the real user message in
    // DB, then a tool-call/assistant placeholder can land before queue_update
    // reaches the client. If the run fails before visible text, result flushing
    // must not append a synthetic duplicate after that placeholder.
    const userContent = 'Also PAR-007 and PAR-008';
    const state = makeState({
      threadDataById: {
        [THREAD_ID]: {
          ...makeState().activeThread,
          messages: [
            { id: 'm-user', role: 'user', content: userContent, threadId: THREAD_ID },
            {
              id: 'm-asst',
              role: 'assistant',
              content: '',
              threadId: THREAD_ID,
              toolCalls: [
                {
                  id: 'tc-1',
                  messageId: 'm-asst',
                  name: 'Bash',
                  input: '{}',
                  timestamp: '2026-01-01T00:00:03.000Z',
                },
              ],
            },
          ],
        },
      },
    });
    const { get, set } = makeGetSet(state);

    handleWSQueueUpdate(get, set, THREAD_ID, {
      threadId: THREAD_ID,
      queuedCount: 0,
      dequeuedMessage: userContent,
    });

    handleWSResult(get, set, THREAD_ID, { status: 'failed', cost: 0, duration: 1 });

    const msgs = state.threadDataById[THREAD_ID].messages;
    const userMsgs = msgs.filter((m: any) => m.role === 'user' && m.content === userContent);
    expect(userMsgs).toHaveLength(1);
  });

  test('handleWSQueueUpdate injects before trailing assistant scaffold when it arrives late', () => {
    // startAgent can create the assistant/tool-call scaffold before the
    // queue_update event carrying dequeuedMessage reaches the client. The
    // follow-up should become visible immediately and stay ordered before
    // the new turn's scaffold.
    const userContent = 'Re-run the failing check';
    const state = makeState({
      threadDataById: {
        [THREAD_ID]: {
          ...makeState().activeThread,
          messages: [
            {
              id: 'm-asst',
              role: 'assistant',
              content: '',
              threadId: THREAD_ID,
              toolCalls: [
                {
                  id: 'tc-1',
                  messageId: 'm-asst',
                  name: 'Bash',
                  input: '{}',
                  timestamp: '2026-01-01T00:00:03.000Z',
                },
              ],
            },
          ],
        },
      },
    });
    const { get, set } = makeGetSet(state);

    handleWSQueueUpdate(get, set, THREAD_ID, {
      threadId: THREAD_ID,
      queuedCount: 0,
      dequeuedMessage: userContent,
    });

    const msgs = state.threadDataById[THREAD_ID].messages;
    const userIdx = msgs.findIndex((m: any) => m.role === 'user' && m.content === userContent);
    const toolIdx = msgs.findIndex((m: any) => m.toolCalls?.some((tc: any) => tc.id === 'tc-1'));
    expect(userIdx).toBe(0);
    expect(toolIdx).toBe(1);

    handleWSResult(get, set, THREAD_ID, { status: 'failed', cost: 0, duration: 1 });
    const userMsgs = state.threadDataById[THREAD_ID].messages.filter(
      (m: any) => m.role === 'user' && m.content === userContent,
    );
    expect(userMsgs).toHaveLength(1);
  });

  test('handleWSResult flushes orphaned dequeued message into thread payload', () => {
    // Regression: bug 3a — when a queue:update arrives with a dequeuedMessage
    // but the next agent:message never lands (agent failed immediately after
    // dequeue), the pendingDequeuedMessages buffer used to leak and inject
    // into an unrelated future turn. handleWSResult must flush it now.
    const state = makeState();
    const { get, set } = makeGetSet(state);

    // Server emits queue:update with the dequeued message just before the
    // new agent run starts.
    handleWSQueueUpdate(get, set, THREAD_ID, {
      threadId: THREAD_ID,
      queuedCount: 0,
      dequeuedMessage: 'ghost message from the queue',
    });

    // Agent fails before emitting any agent:message — only a result event.
    handleWSResult(get, set, THREAD_ID, { status: 'failed', cost: 0, duration: 1 });

    const messages = state.threadDataById[THREAD_ID].messages;
    const userMsg = messages.find((m: any) => m.role === 'user');
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toBe('ghost message from the queue');

    // A subsequent unrelated agent:message must NOT re-inject the same content
    // (buffer was cleared by handleWSResult).
    handleWSMessage(get, set, THREAD_ID, {
      role: 'assistant',
      content: 'response to a new, unrelated turn',
    });
    const userMsgs = state.threadDataById[THREAD_ID].messages.filter((m: any) => m.role === 'user');
    expect(userMsgs).toHaveLength(1);
  });

  test('handleWSToolCall injects the dequeued user card when the turn starts with a tool call', () => {
    // Regression: in queue mode the dequeued user message is parked in the
    // buffer and was injected ONLY on the next assistant message. When a queued
    // follow-up kicked off its turn with a tool call (very common), the user
    // card stayed invisible for the whole tool phase — and on surfaces that
    // never refresh, until the first assistant text finally landed.
    const userContent = 'Re-verify the report';
    const state = makeState();
    const { get, set } = makeGetSet(state);

    // Dequeue buffers the user message.
    handleWSQueueUpdate(get, set, THREAD_ID, {
      threadId: THREAD_ID,
      queuedCount: 0,
      dequeuedMessage: userContent,
    });

    // Agent starts the turn with a tool call — NO assistant message yet.
    handleWSToolCall(get, set, THREAD_ID, {
      toolCallId: 'tc-1',
      messageId: 'm-asst',
      name: 'Bash',
      input: { command: 'grep ...' },
    });

    const msgs = state.threadDataById[THREAD_ID].messages;
    const userIdx = msgs.findIndex((m: any) => m.role === 'user' && m.content === userContent);
    const toolIdx = msgs.findIndex((m: any) => m.toolCalls?.some((tc: any) => tc.id === 'tc-1'));

    // The user card is present and ordered before the tool call's message.
    expect(userIdx).toBeGreaterThanOrEqual(0);
    expect(toolIdx).toBeGreaterThan(userIdx);

    // A later assistant message must NOT inject a second copy (buffer cleared).
    handleWSMessage(get, set, THREAD_ID, {
      messageId: 'm-asst',
      role: 'assistant',
      content: 'Voy a anexar al documento…',
    });
    const userMsgs = state.threadDataById[THREAD_ID].messages.filter(
      (m: any) => m.role === 'user' && m.content === userContent,
    );
    expect(userMsgs).toHaveLength(1);
  });

  test('handleWSResult updates a scratch thread via threadsById', () => {
    const scratchThread = {
      id: 'scratch-2',
      projectId: '',
      isScratch: true,
      title: 'hola',
      status: 'running',
      cost: 0,
      messages: [],
    };
    const state = makeState({
      activeThread: null,
      selectedThreadId: null,
      threadsById: { 'scratch-2': scratchThread },
      threadIdsByProject: {},
      scratchThreadIds: ['scratch-2'],
      threadDataById: {},
    });
    const { get, set } = makeGetSet(state);

    handleWSResult(get, set, 'scratch-2', { status: 'completed', cost: 0.5, duration: 1 });

    expect(state.threadsById['scratch-2'].status).toBe('completed');
    expect(state.threadsById['scratch-2'].cost).toBe(0.5);
    expect(state.threadsById['scratch-2'].completedAt).toBeDefined();
    expect(state.threadsById['scratch-2'].updatedAt).toBeDefined();
  });
});
