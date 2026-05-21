/**
 * Regression tests for thread-service/messaging.ts sendMessage().
 *
 * Covers the idle/backlog branch that previously crashed when
 * `tm.getThreadMessages` returned a bare array (the runner-mode stub).
 * destructuring `{ messages }` from an array gave `undefined`, then
 * `draftMessages[0]` threw "undefined is not an object".
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  tm: {
    getThread: vi.fn(),
    updateThread: vi.fn(async () => undefined),
    getThreadMessages: vi.fn(),
    insertMessage: vi.fn(async () => 'msg-new'),
    updateMessage: vi.fn(async () => undefined),
    findLastUnansweredInteractiveToolCall: vi.fn(async () => undefined),
    updateToolCallOutput: vi.fn(async () => undefined),
  },
  projects: {
    resolveProjectPath: vi.fn(),
    getProject: vi.fn(),
  },
  messageQueue: {
    enqueue: vi.fn(),
    queueCount: vi.fn(async () => 0),
    peek: vi.fn(async () => null),
  },
}));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../services/agent-runner.js', () => ({
  startAgent: vi.fn(async () => undefined),
  stopAgent: vi.fn(async () => undefined),
  isAgentRunning: vi.fn(() => false),
}));

vi.mock('../../services/ingest-mapper.js', () => ({
  cleanupExternalThread: vi.fn(),
}));

vi.mock('../../services/permission-rules-client.js', () => ({
  listPermissionRules: vi.fn(async () => []),
  createPermissionRule: vi.fn(async () => undefined),
}));

vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: { emit: vi.fn(), emitToUser: vi.fn() },
}));

vi.mock('../../utils/file-mentions.js', () => ({
  augmentPromptWithFiles: vi.fn(async (content: string) => content),
  augmentPromptWithSymbols: vi.fn(async (content: string) => content),
  stripInlineReferencedContent: vi.fn((content: string) => content),
}));

vi.mock('../../services/thread-manager.js', () => mocks.tm);

vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    projects: mocks.projects,
    messageQueue: mocks.messageQueue,
  }),
}));

import { ok } from 'neverthrow';

import { sendMessage } from '../../services/thread-service/messaging.js';

describe('sendMessage — idle/backlog regression', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.resolveProjectPath.mockResolvedValue(ok('/projects/test'));
    mocks.projects.getProject.mockResolvedValue({ followUpMode: 'interrupt' });
  });

  test('does not throw when no draft message exists for an idle/backlog thread', async () => {
    mocks.tm.getThread.mockResolvedValue({
      id: 't-idle',
      userId: 'u-1',
      projectId: 'p-1',
      status: 'idle',
      stage: 'backlog',
      provider: 'claude',
      model: 'sonnet',
      permissionMode: 'autoEdit',
      sessionId: null,
      worktreePath: null,
      initialPrompt: 'first prompt',
    });
    mocks.tm.getThreadMessages.mockResolvedValue({ messages: [], hasMore: false });

    const result = await sendMessage({
      threadId: 't-idle',
      userId: 'u-1',
      content: 'first prompt',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.getThreadMessages).toHaveBeenCalledWith({
      threadId: 't-idle',
      limit: 1,
    });
    expect(mocks.tm.insertMessage).toHaveBeenCalledTimes(1);
    expect(mocks.tm.updateMessage).not.toHaveBeenCalled();
  });

  test('updates the existing draft user message when one is present', async () => {
    mocks.tm.getThread.mockResolvedValue({
      id: 't-idle',
      userId: 'u-1',
      projectId: 'p-1',
      status: 'idle',
      stage: 'backlog',
      provider: 'claude',
      model: 'sonnet',
      permissionMode: 'autoEdit',
      sessionId: null,
      worktreePath: null,
      initialPrompt: 'old prompt',
    });
    const draft = { id: 'msg-draft', role: 'user', content: 'old prompt', images: null };
    mocks.tm.getThreadMessages.mockResolvedValue({ messages: [draft], hasMore: false });

    const result = await sendMessage({
      threadId: 't-idle',
      userId: 'u-1',
      content: 'new prompt',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.updateMessage).toHaveBeenCalledWith('msg-draft', expect.any(Object));
    expect(mocks.tm.insertMessage).not.toHaveBeenCalled();
  });

  test('sets title from prompt when idle thread has no initialPrompt (live view draft)', async () => {
    mocks.tm.getThread.mockResolvedValue({
      id: 't-draft',
      userId: 'u-1',
      projectId: 'p-1',
      status: 'idle',
      stage: 'backlog',
      provider: 'claude',
      model: 'sonnet',
      permissionMode: 'autoEdit',
      sessionId: null,
      worktreePath: null,
      initialPrompt: null,
    });
    mocks.tm.getThreadMessages.mockResolvedValue({ messages: [], hasMore: false });

    const result = await sendMessage({
      threadId: 't-draft',
      userId: 'u-1',
      content: 'Fix the login bug',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      't-draft',
      expect.objectContaining({
        stage: 'in_progress',
        title: 'Fix the login bug',
        initialPrompt: 'Fix the login bug',
      }),
    );
  });

  test('handles non-idle threads without calling getThreadMessages for draft detection', async () => {
    mocks.tm.getThread.mockResolvedValue({
      id: 't-running',
      userId: 'u-1',
      projectId: 'p-1',
      status: 'completed',
      stage: 'in_progress',
      provider: 'claude',
      model: 'sonnet',
      permissionMode: 'autoEdit',
      sessionId: 'sess-1',
      worktreePath: null,
    });

    const result = await sendMessage({
      threadId: 't-running',
      userId: 'u-1',
      content: 'follow up',
    });

    expect(result.isOk()).toBe(true);
    // Idle/backlog branch should be skipped entirely.
    expect(mocks.tm.getThreadMessages).not.toHaveBeenCalled();
    expect(mocks.tm.insertMessage).toHaveBeenCalledTimes(1);
  });

  test('scratch threads send messages without requiring a project', async () => {
    mocks.tm.getThread.mockResolvedValue({
      id: 't-scratch',
      userId: 'u-1',
      projectId: '',
      isScratch: true,
      status: 'completed',
      stage: 'in_progress',
      provider: 'claude',
      model: 'sonnet',
      permissionMode: 'autoEdit',
      sessionId: 'sess-1',
      worktreePath: null,
    });

    const result = await sendMessage({
      threadId: 't-scratch',
      userId: 'u-1',
      content: 'follow up',
    });

    expect(result.isOk()).toBe(true);
    // Scratch threads must not hit resolveProjectPath or getProject.
    expect(mocks.projects.resolveProjectPath).not.toHaveBeenCalled();
    expect(mocks.projects.getProject).not.toHaveBeenCalled();
    expect(mocks.tm.insertMessage).toHaveBeenCalledTimes(1);
  });
});
