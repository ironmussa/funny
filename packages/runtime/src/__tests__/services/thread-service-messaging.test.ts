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
    insertToolCall: vi.fn(async () => 'tc-shell'),
    updateMessage: vi.fn(async () => undefined),
    findLastUnansweredInteractiveToolCall: vi.fn(async () => undefined),
    updateToolCallOutput: vi.fn(async () => undefined),
    deleteComment: vi.fn(async () => undefined),
  },
  projects: {
    resolveProjectPath: vi.fn(),
    getProject: vi.fn(),
  },
  messageQueue: {
    enqueue: vi.fn(),
    queueCount: vi.fn(async () => 0),
    peek: vi.fn(async () => null),
    cancel: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../services/agent-runner.js', () => ({
  startAgent: vi.fn(async () => undefined),
  stopAgent: vi.fn(async () => undefined),
  isAgentRunning: vi.fn(() => false),
  getSupportedSlashCommands: vi.fn(() => undefined),
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

import {
  startAgent,
  stopAgent,
  isAgentRunning,
  getSupportedSlashCommands,
} from '../../services/agent-runner.js';
import { cleanupExternalThread } from '../../services/ingest-mapper.js';
import {
  createPermissionRule,
  listPermissionRules,
} from '../../services/permission-rules-client.js';
import {
  sendMessage,
  stopThread,
  approveToolCall,
  cancelQueuedMessage,
  updateQueuedMessage,
  deleteComment,
} from '../../services/thread-service/messaging.js';
import { wsBroker } from '../../services/ws-broker.js';

describe('sendMessage — slash-command guardrail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.getProject.mockResolvedValue({ followUpMode: 'interrupt' });
    mocks.tm.getThreadMessages.mockResolvedValue({ messages: [], hasMore: false });
    mocks.tm.getThread.mockResolvedValue({
      id: 't-cmd',
      userId: 'u-1',
      projectId: 'p-1',
      status: 'completed',
      stage: 'in_progress',
      provider: 'claude',
      model: 'sonnet',
      permissionMode: 'autoEdit',
      sessionId: 's-1',
      worktreePath: null,
    });
  });

  test('rejects an unknown slash command with a 400 instead of sending it', async () => {
    vi.mocked(getSupportedSlashCommands).mockReturnValue(new Set(['compact', 'clear', 'context']));

    const result = await sendMessage({ threadId: 't-cmd', userId: 'u-1', content: '/compcat' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(400);
    expect(startAgent).not.toHaveBeenCalled();
  });

  test('allows a known slash command through to the agent', async () => {
    vi.mocked(getSupportedSlashCommands).mockReturnValue(new Set(['compact', 'clear', 'context']));

    const result = await sendMessage({ threadId: 't-cmd', userId: 'u-1', content: '/compact' });

    expect(result.isOk()).toBe(true);
    expect(startAgent).toHaveBeenCalledTimes(1);
  });

  test('allows any slash command when no command list was captured (cannot validate)', async () => {
    vi.mocked(getSupportedSlashCommands).mockReturnValue(undefined);

    const result = await sendMessage({ threadId: 't-cmd', userId: 'u-1', content: '/whatever' });

    expect(result.isOk()).toBe(true);
    expect(startAgent).toHaveBeenCalledTimes(1);
  });

  test('does not treat a normal prompt as a command', async () => {
    vi.mocked(getSupportedSlashCommands).mockReturnValue(new Set(['compact']));

    const result = await sendMessage({
      threadId: 't-cmd',
      userId: 'u-1',
      content: 'please run /compact for me',
    });

    expect(result.isOk()).toBe(true);
    expect(startAgent).toHaveBeenCalledTimes(1);
  });
});

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

describe('sendMessage — shell escape', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.getProject.mockResolvedValue({
      followUpMode: 'interrupt',
      path: process.cwd(),
    });
    mocks.tm.getThreadMessages.mockResolvedValue({ messages: [], hasMore: false });
    mocks.tm.getThread.mockResolvedValue({
      id: 't-shell',
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
    mocks.tm.insertMessage
      .mockResolvedValueOnce('msg-user-shell')
      .mockResolvedValueOnce('msg-assistant-shell');
  });

  test('executes ! commands locally and emits persisted messages without starting the agent', async () => {
    const result = await sendMessage({
      threadId: 't-shell',
      userId: 'u-1',
      content: '!printf "hello shell"',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ ok: true, handledLocally: 'shell_escape' });
    }
    expect(startAgent).not.toHaveBeenCalled();
    expect(mocks.tm.insertMessage).toHaveBeenCalledTimes(2);
    expect(mocks.tm.insertMessage).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        threadId: 't-shell',
        role: 'user',
        content: '!printf "hello shell"',
      }),
    );
    expect(mocks.tm.insertMessage).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        threadId: 't-shell',
        role: 'assistant',
        content: '',
      }),
    );
    expect(mocks.tm.insertToolCall).toHaveBeenCalledWith({
      messageId: 'msg-assistant-shell',
      name: 'Bash',
      input: JSON.stringify({ command: 'printf "hello shell"' }),
      author: 'shell',
    });
    expect(mocks.tm.updateToolCallOutput).toHaveBeenCalledWith(
      'tc-shell',
      expect.stringContaining('hello shell'),
    );
    expect(wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'agent:message',
        threadId: 't-shell',
        data: expect.objectContaining({
          messageId: 'msg-user-shell',
          role: 'user',
          content: '!printf "hello shell"',
        }),
      }),
    );
    expect(wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'agent:tool_call',
        threadId: 't-shell',
        data: expect.objectContaining({
          toolCallId: 'tc-shell',
          messageId: 'msg-assistant-shell',
          name: 'Bash',
          input: { command: 'printf "hello shell"' },
          author: 'shell',
        }),
      }),
    );
    expect(wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'agent:tool_output',
        threadId: 't-shell',
        data: expect.objectContaining({
          toolCallId: 'tc-shell',
          output: expect.stringContaining('hello shell'),
        }),
      }),
    );
  });

  test('rejects bare ! shell escapes', async () => {
    const result = await sendMessage({ threadId: 't-shell', userId: 'u-1', content: '!' });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(400);
    expect(startAgent).not.toHaveBeenCalled();
    expect(mocks.tm.insertMessage).not.toHaveBeenCalled();
  });

  test('rejects shell escapes from non-owners even when they can steer the thread', async () => {
    const result = await sendMessage({
      threadId: 't-shell',
      userId: 'u-2',
      content: '!pwd',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(403);
    expect(startAgent).not.toHaveBeenCalled();
    expect(mocks.tm.insertMessage).not.toHaveBeenCalled();
  });
});

describe('sendMessage — queue and interactive tool flows', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.resolveProjectPath.mockResolvedValue(ok('/projects/test'));
    mocks.projects.getProject.mockResolvedValue({ followUpMode: 'queue', path: '/projects/test' });
    vi.mocked(isAgentRunning).mockReturnValue(false);
  });

  test('queues follow-up when agent is running and project uses queue mode', async () => {
    vi.mocked(isAgentRunning).mockReturnValue(true);
    mocks.messageQueue.enqueue.mockResolvedValue({ id: 'queued-1' });
    mocks.messageQueue.queueCount.mockResolvedValue(2);
    mocks.messageQueue.peek.mockResolvedValue({ content: 'second message' });

    mocks.tm.getThread.mockResolvedValue({
      id: 't-running',
      userId: 'u-1',
      projectId: 'p-1',
      status: 'running',
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
      content: 'second message',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        ok: true,
        queued: true,
        queuedCount: 2,
        queuedMessageId: 'queued-1',
      });
    }
    expect(mocks.messageQueue.enqueue).toHaveBeenCalledWith(
      't-running',
      expect.objectContaining({
        content: 'second message',
        model: 'sonnet',
        permissionMode: 'autoEdit',
      }),
    );
    expect(mocks.tm.insertMessage).not.toHaveBeenCalled();
    expect(wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({ type: 'thread:queue_update' }),
    );
    expect(startAgent).not.toHaveBeenCalled();
  });

  test('steers the live turn (no queue) when running and project uses steer mode', async () => {
    mocks.projects.getProject.mockResolvedValue({
      followUpMode: 'steer',
      path: '/projects/test',
    });
    vi.mocked(isAgentRunning).mockReturnValue(true);

    mocks.tm.getThread.mockResolvedValue({
      id: 't-running',
      userId: 'u-1',
      projectId: 'p-1',
      status: 'running',
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
      content: 'go left instead',
    });

    expect(result.isOk()).toBe(true);
    // Steer mode never queues — it redirects the live turn.
    expect(mocks.messageQueue.enqueue).not.toHaveBeenCalled();
    expect(startAgent).toHaveBeenCalledTimes(1);
    // steer is the 13th positional arg (index 12) of startAgent.
    const call = vi.mocked(startAgent).mock.calls.at(-1);
    expect(call?.[0]).toBe('t-running');
    expect(call?.[12]).toBe(true);
  });

  test('queues (does not steer) a heavy-thinking Claude turn to avoid poisoning the session', async () => {
    mocks.projects.getProject.mockResolvedValue({
      followUpMode: 'steer',
      path: '/projects/test',
    });
    vi.mocked(isAgentRunning).mockReturnValue(true);
    mocks.messageQueue.enqueue.mockResolvedValue({ id: 'queued-1' });
    mocks.messageQueue.queueCount.mockResolvedValue(1);
    mocks.messageQueue.peek.mockResolvedValue({ content: 'go left instead' });

    mocks.tm.getThread.mockResolvedValue({
      id: 't-running',
      userId: 'u-1',
      projectId: 'p-1',
      status: 'running',
      stage: 'in_progress',
      provider: 'claude',
      model: 'opus-4.8',
      permissionMode: 'autoEdit',
      sessionId: 'sess-1',
      worktreePath: null,
    });

    const result = await sendMessage({
      threadId: 't-running',
      userId: 'u-1',
      content: 'go left instead',
      effort: 'xhigh',
    });

    expect(result.isOk()).toBe(true);
    // Heavy thinking must NOT interrupt mid-turn — it queues instead.
    expect(startAgent).not.toHaveBeenCalled();
    expect(mocks.messageQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  test('still steers a Claude turn under light thinking (effort high)', async () => {
    mocks.projects.getProject.mockResolvedValue({
      followUpMode: 'steer',
      path: '/projects/test',
    });
    vi.mocked(isAgentRunning).mockReturnValue(true);

    mocks.tm.getThread.mockResolvedValue({
      id: 't-running',
      userId: 'u-1',
      projectId: 'p-1',
      status: 'running',
      stage: 'in_progress',
      provider: 'claude',
      model: 'opus-4.8',
      permissionMode: 'autoEdit',
      sessionId: 'sess-1',
      worktreePath: null,
    });

    const result = await sendMessage({
      threadId: 't-running',
      userId: 'u-1',
      content: 'go left instead',
      effort: 'high',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.messageQueue.enqueue).not.toHaveBeenCalled();
    expect(startAgent).toHaveBeenCalledTimes(1);
    const call = vi.mocked(startAgent).mock.calls.at(-1);
    expect(call?.[12]).toBe(true); // steer flag
  });

  test('upgrades permission mode after ExitPlanMode approval', async () => {
    mocks.tm.getThread.mockResolvedValue({
      id: 't-waiting',
      userId: 'u-1',
      projectId: 'p-1',
      status: 'waiting',
      stage: 'in_progress',
      provider: 'claude',
      model: 'sonnet',
      permissionMode: 'plan',
      sessionId: 'sess-1',
      worktreePath: null,
    });
    mocks.tm.findLastUnansweredInteractiveToolCall.mockResolvedValue({
      id: 'tc-plan',
      name: 'ExitPlanMode',
    });

    const result = await sendMessage({
      threadId: 't-waiting',
      userId: 'u-1',
      content: 'Approved plan',
      permissionMode: 'plan',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.updateToolCallOutput).toHaveBeenCalledWith('tc-plan', 'Approved plan');
    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      't-waiting',
      expect.objectContaining({ permissionMode: 'autoEdit' }),
    );
    expect(wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'thread:updated',
        data: { permissionMode: 'autoEdit' },
      }),
    );
  });

  test('clears sessionId when provider changes mid-thread', async () => {
    mocks.tm.getThread.mockResolvedValue({
      id: 't-completed',
      userId: 'u-1',
      projectId: 'p-1',
      status: 'completed',
      stage: 'in_progress',
      provider: 'claude',
      model: 'sonnet',
      permissionMode: 'autoEdit',
      sessionId: 'old-session',
      worktreePath: null,
    });

    const result = await sendMessage({
      threadId: 't-completed',
      userId: 'u-1',
      content: 'continue with codex',
      provider: 'codex',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      't-completed',
      expect.objectContaining({
        provider: 'codex',
        sessionId: null,
        contextRecoveryReason: 'provider_changed',
      }),
    );
  });

  test('clears sessionId when model changes mid-thread', async () => {
    mocks.tm.getThread.mockResolvedValue({
      id: 't-completed',
      userId: 'u-1',
      projectId: 'p-1',
      status: 'completed',
      stage: 'in_progress',
      provider: 'claude',
      model: 'sonnet',
      permissionMode: 'autoEdit',
      sessionId: 'old-session',
      worktreePath: null,
    });

    const result = await sendMessage({
      threadId: 't-completed',
      userId: 'u-1',
      content: 'switch model',
      model: 'opus',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.updateThread).toHaveBeenCalledWith(
      't-completed',
      expect.objectContaining({
        model: 'opus',
        sessionId: null,
        contextRecoveryReason: 'model_changed',
      }),
    );
  });

  test('queues with broadcast emit when thread has no userId', async () => {
    vi.mocked(isAgentRunning).mockReturnValue(true);
    mocks.messageQueue.enqueue.mockResolvedValue({ id: 'queued-1' });
    mocks.messageQueue.queueCount.mockResolvedValue(1);
    mocks.messageQueue.peek.mockResolvedValue({ content: 'queued' });

    mocks.tm.getThread.mockResolvedValue({
      id: 't-anon',
      userId: '',
      projectId: 'p-1',
      status: 'running',
      stage: 'in_progress',
      provider: 'claude',
      model: 'sonnet',
      permissionMode: 'autoEdit',
      sessionId: 'sess-1',
      worktreePath: null,
    });

    const result = await sendMessage({
      threadId: 't-anon',
      userId: '',
      content: 'queued without owner',
      forceQueue: true,
    });

    expect(result.isOk()).toBe(true);
    expect(wsBroker.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'thread:queue_update' }),
    );
    expect(wsBroker.emitToUser).not.toHaveBeenCalled();
  });

  test('continues when resolving pending interactive tool call fails', async () => {
    mocks.tm.getThread.mockResolvedValue({
      id: 't-running',
      userId: 'u-1',
      projectId: 'p-1',
      status: 'running',
      stage: 'in_progress',
      provider: 'claude',
      model: 'sonnet',
      permissionMode: 'autoEdit',
      sessionId: 'sess-1',
      worktreePath: null,
    });
    mocks.tm.findLastUnansweredInteractiveToolCall.mockRejectedValue(new Error('db timeout'));

    const result = await sendMessage({
      threadId: 't-running',
      userId: 'u-1',
      content: 'answer anyway',
    });

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.insertMessage).toHaveBeenCalled();
    expect(startAgent).toHaveBeenCalled();
  });

  test('logs but does not fail when background startAgent rejects', async () => {
    vi.mocked(startAgent).mockRejectedValueOnce(new Error('spawn failed'));
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
      content: 'retry',
    });

    expect(result.isOk()).toBe(true);
    await vi.waitFor(() => {
      expect(startAgent).toHaveBeenCalled();
    });
  });
});

describe('stopThread', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns 404 when thread is missing', async () => {
    mocks.tm.getThread.mockResolvedValue(null);

    const result = await stopThread('missing');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.statusCode).toBe(404);
    }
  });

  test('stops a running local agent', async () => {
    mocks.tm.getThread.mockResolvedValue({
      id: 't-1',
      provider: 'claude',
    });

    const result = await stopThread('t-1');

    expect(result.isOk()).toBe(true);
    expect(stopAgent).toHaveBeenCalledWith('t-1');
  });

  test('cleans up external provider threads via ingest mapper', async () => {
    mocks.tm.getThread.mockResolvedValue({
      id: 't-ext',
      provider: 'external',
    });

    const result = await stopThread('t-ext');

    expect(result.isOk()).toBe(true);
    expect(cleanupExternalThread).toHaveBeenCalledWith('t-ext');
    expect(stopAgent).not.toHaveBeenCalled();
  });
});

describe('approveToolCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.projects.resolveProjectPath.mockResolvedValue(ok('/projects/test'));
    mocks.projects.getProject.mockResolvedValue({ id: 'p-1', path: '/projects/test' });
    mocks.tm.getThread.mockResolvedValue({
      id: 't-1',
      userId: 'u-1',
      projectId: 'p-1',
      provider: 'claude',
      model: 'sonnet',
      permissionMode: 'autoEdit',
      worktreePath: null,
    });
  });

  test('returns 404 when thread is missing', async () => {
    mocks.tm.getThread.mockResolvedValue(undefined);

    const result = await approveToolCall({
      threadId: 'missing',
      userId: 'u-1',
      toolName: 'Bash',
      approved: true,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(404);
  });

  test('restarts agent with approval message when approved', async () => {
    const result = await approveToolCall({
      threadId: 't-1',
      userId: 'u-1',
      toolName: 'Bash',
      approved: true,
      toolInput: 'npm test',
    });

    expect(result.isOk()).toBe(true);
    expect(startAgent).toHaveBeenCalledWith(
      't-1',
      expect.stringContaining('approved'),
      '/projects/test',
      'sonnet',
      'autoEdit',
      undefined,
      undefined,
      expect.arrayContaining(['Bash']),
      'claude',
    );
  });

  test('persists always-allow rule when scope is always', async () => {
    const result = await approveToolCall({
      threadId: 't-1',
      userId: 'u-1',
      toolName: 'Bash',
      approved: true,
      scope: 'always',
      toolInput: 'npm test',
    });

    expect(result.isOk()).toBe(true);
    expect(createPermissionRule).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'u-1',
        toolName: 'Bash',
        pattern: 'npm',
        decision: 'allow',
      }),
    );
  });

  test('restarts agent with denial message when not approved', async () => {
    const result = await approveToolCall({
      threadId: 't-1',
      userId: 'u-1',
      toolName: 'Bash',
      approved: false,
      disallowedTools: ['Bash'],
    });

    expect(result.isOk()).toBe(true);
    expect(startAgent).toHaveBeenCalledWith(
      't-1',
      expect.stringContaining('denied'),
      '/projects/test',
      'sonnet',
      'autoEdit',
      undefined,
      ['Bash'],
      undefined,
      'claude',
    );
  });

  test('continues approval flow when always-allow rule persistence fails', async () => {
    vi.mocked(createPermissionRule).mockRejectedValueOnce(new Error('network error'));

    const result = await approveToolCall({
      threadId: 't-1',
      userId: 'u-1',
      toolName: 'Bash',
      approved: true,
      scope: 'always',
      toolInput: 'npm test',
    });

    expect(result.isOk()).toBe(true);
    expect(startAgent).toHaveBeenCalled();
  });

  test('merges always-allow permission rules into approved tool restart', async () => {
    vi.mocked(listPermissionRules).mockResolvedValue([{ toolName: 'Read', decision: 'allow' }]);

    const result = await approveToolCall({
      threadId: 't-1',
      userId: 'u-1',
      toolName: 'Bash',
      approved: true,
    });

    expect(result.isOk()).toBe(true);
    expect(startAgent).toHaveBeenCalledWith(
      't-1',
      expect.any(String),
      '/projects/test',
      'sonnet',
      'autoEdit',
      undefined,
      undefined,
      expect.arrayContaining(['Read', 'Bash']),
      'claude',
    );
  });
});

describe('queue operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tm.getThread.mockResolvedValue({ id: 't-1', userId: 'u-1' });
  });

  test('cancelQueuedMessage returns 404 when message is not queued', async () => {
    mocks.messageQueue.cancel.mockResolvedValue(false);

    const result = await cancelQueuedMessage('t-1', 'q-missing');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(404);
  });

  test('cancelQueuedMessage emits queue update to thread owner', async () => {
    mocks.messageQueue.cancel.mockResolvedValue(true);
    mocks.messageQueue.queueCount.mockResolvedValue(1);
    mocks.messageQueue.peek.mockResolvedValue({ content: 'next prompt in queue' });

    const result = await cancelQueuedMessage('t-1', 'q-1');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.queuedCount).toBe(1);
    expect(wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'thread:queue_update',
        data: expect.objectContaining({
          queuedCount: 1,
          nextMessage: 'next prompt in queue',
        }),
      }),
    );
  });

  test('updateQueuedMessage returns updated message and queue count', async () => {
    mocks.messageQueue.update.mockResolvedValue({ id: 'q-1', content: 'edited' });
    mocks.messageQueue.queueCount.mockResolvedValue(2);
    mocks.messageQueue.peek.mockResolvedValue({ content: 'edited' });

    const result = await updateQueuedMessage('t-1', 'q-1', 'edited');

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.queuedMessage.content).toBe('edited');
      expect(result.value.queuedCount).toBe(2);
    }
  });

  test('updateQueuedMessage returns 404 when message is missing', async () => {
    mocks.messageQueue.update.mockResolvedValue(null);

    const result = await updateQueuedMessage('t-1', 'q-missing', 'x');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(404);
  });

  test('cancelQueuedMessage broadcasts when thread owner is missing', async () => {
    mocks.tm.getThread.mockResolvedValue({ id: 't-1', userId: '' });
    mocks.messageQueue.cancel.mockResolvedValue(true);
    mocks.messageQueue.queueCount.mockResolvedValue(0);
    mocks.messageQueue.peek.mockResolvedValue(null);

    const result = await cancelQueuedMessage('t-1', 'q-1');

    expect(result.isOk()).toBe(true);
    expect(wsBroker.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'thread:queue_update' }),
    );
  });

  test('updateQueuedMessage broadcasts when thread owner is missing', async () => {
    mocks.tm.getThread.mockResolvedValue({ id: 't-1', userId: '' });
    mocks.messageQueue.update.mockResolvedValue({ id: 'q-1', content: 'edited' });
    mocks.messageQueue.queueCount.mockResolvedValue(1);
    mocks.messageQueue.peek.mockResolvedValue({ content: 'edited' });

    const result = await updateQueuedMessage('t-1', 'q-1', 'edited');

    expect(result.isOk()).toBe(true);
    expect(wsBroker.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'thread:queue_update' }),
    );
  });
});

describe('deleteComment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('returns 404 when thread is missing', async () => {
    mocks.tm.getThread.mockResolvedValue(undefined);

    const result = await deleteComment('missing', 'c-1');

    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.statusCode).toBe(404);
  });

  test('deletes comment and emits WS event', async () => {
    mocks.tm.getThread.mockResolvedValue({ id: 't-1', userId: 'u-1' });

    const result = await deleteComment('t-1', 'c-1');

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.deleteComment).toHaveBeenCalledWith('c-1');
    expect(wsBroker.emitToUser).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({
        type: 'thread:comment_deleted',
        data: { commentId: 'c-1' },
      }),
    );
  });

  test('deletes comment without WS event when thread has no userId', async () => {
    mocks.tm.getThread.mockResolvedValue({ id: 't-1', userId: '' });

    const result = await deleteComment('t-1', 'c-1');

    expect(result.isOk()).toBe(true);
    expect(mocks.tm.deleteComment).toHaveBeenCalledWith('c-1');
    expect(wsBroker.emitToUser).not.toHaveBeenCalled();
  });
});
