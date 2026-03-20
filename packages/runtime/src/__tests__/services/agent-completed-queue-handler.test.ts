/**
 * Tests for agent-completed-queue-handler.ts
 *
 * Verifies that when an agent completes, the handler:
 * 1. Dequeues the next message from the queue
 * 2. Starts the agent with the dequeued message
 * 3. Emits a queue update event to the user
 * 4. Re-enqueues the message if startAgent fails
 * 5. Does nothing if the project uses a non-queue follow-up mode
 * 6. Does nothing if the queue is empty
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';

import { agentCompletedQueueHandler } from '../../services/handlers/agent-completed-queue-handler.js';
import type { HandlerServiceContext } from '../../services/handlers/types.js';
import type { AgentCompletedEvent } from '../../services/thread-event-bus.js';

// ── Helpers ────────────────────────────────────────────────────

function makeEvent(overrides: Partial<AgentCompletedEvent> = {}): AgentCompletedEvent {
  return {
    threadId: 't-1',
    projectId: 'p-1',
    userId: 'u-1',
    worktreePath: null,
    cwd: '/projects/test',
    status: 'completed',
    cost: 0.05,
    ...overrides,
  };
}

function makeQueueEntry(overrides: Record<string, any> = {}) {
  return {
    id: 'q-1',
    threadId: 't-1',
    content: 'Queued prompt',
    provider: null,
    model: null,
    permissionMode: null,
    images: null,
    allowedTools: null,
    disallowedTools: null,
    fileReferences: null,
    sortOrder: 0,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeCtx(overrides: Partial<HandlerServiceContext> = {}): HandlerServiceContext {
  return {
    getThread: vi.fn(async () => ({
      id: 't-1',
      projectId: 'p-1',
      userId: 'u-1',
      model: 'opus',
      provider: 'claude',
      permissionMode: 'autoEdit',
      worktreePath: null,
    })),
    getProject: vi.fn(async () => ({
      id: 'p-1',
      path: '/projects/test',
      followUpMode: 'queue',
    })),
    dequeueMessage: vi.fn(async () => null),
    enqueueMessage: vi.fn(async () => makeQueueEntry()),
    queueCount: vi.fn(async () => 0),
    peekMessage: vi.fn(async () => null),
    startAgent: vi.fn(async () => {}),
    emitToUser: vi.fn(),
    broadcast: vi.fn(),
    log: vi.fn(),
    updateThread: vi.fn(),
    insertComment: vi.fn(),
    getGitStatusSummary: vi.fn() as any,
    deriveGitSyncState: vi.fn() as any,
    invalidateGitStatusCache: vi.fn(),
    saveThreadEvent: vi.fn(async () => {}),
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('agentCompletedQueueHandler', () => {
  test('has correct metadata', () => {
    expect(agentCompletedQueueHandler.name).toBe('drain-message-queue-on-completion');
    expect(agentCompletedQueueHandler.event).toBe('agent:completed');
  });

  // ── Skips (no-op scenarios) ─────────────────────────────

  test('does nothing when thread is not found', async () => {
    const ctx = makeCtx({ getThread: vi.fn(async () => undefined) });
    await agentCompletedQueueHandler.action(makeEvent(), ctx);

    expect(ctx.dequeueMessage).not.toHaveBeenCalled();
    expect(ctx.startAgent).not.toHaveBeenCalled();
  });

  test('does nothing when project is not found', async () => {
    const ctx = makeCtx({ getProject: vi.fn(async () => undefined) });
    await agentCompletedQueueHandler.action(makeEvent(), ctx);

    expect(ctx.dequeueMessage).not.toHaveBeenCalled();
    expect(ctx.startAgent).not.toHaveBeenCalled();
  });

  test('does nothing when followUpMode is "interrupt"', async () => {
    const ctx = makeCtx({
      getProject: vi.fn(async () => ({ id: 'p-1', path: '/test', followUpMode: 'interrupt' })),
    });
    await agentCompletedQueueHandler.action(makeEvent(), ctx);

    expect(ctx.dequeueMessage).not.toHaveBeenCalled();
    expect(ctx.startAgent).not.toHaveBeenCalled();
  });

  test('does nothing when queue is empty (dequeue returns null)', async () => {
    const ctx = makeCtx({ dequeueMessage: vi.fn(async () => null) });
    await agentCompletedQueueHandler.action(makeEvent(), ctx);

    expect(ctx.dequeueMessage).toHaveBeenCalledWith('t-1');
    expect(ctx.startAgent).not.toHaveBeenCalled();
  });

  // ── Happy path ──────────────────────────────────────────

  test('dequeues and starts agent with the next message', async () => {
    const entry = makeQueueEntry({ content: 'Do the thing' });
    const ctx = makeCtx({
      dequeueMessage: vi.fn(async () => entry),
      queueCount: vi.fn(async () => 0),
      peekMessage: vi.fn(async () => null),
    });

    await agentCompletedQueueHandler.action(makeEvent(), ctx);

    expect(ctx.dequeueMessage).toHaveBeenCalledWith('t-1');
    expect(ctx.startAgent).toHaveBeenCalledWith(
      't-1',
      'Do the thing',
      '/projects/test', // cwd = project.path (worktreePath is null)
      'opus', // thread.model
      'autoEdit', // thread.permissionMode
      undefined, // images (null → undefined)
      undefined, // disallowedTools
      undefined, // allowedTools
      'claude', // thread.provider
      true, // skipMessageInsert
    );
  });

  test('uses worktreePath as cwd when available', async () => {
    const entry = makeQueueEntry();
    const ctx = makeCtx({
      getThread: vi.fn(async () => ({
        id: 't-1',
        projectId: 'p-1',
        userId: 'u-1',
        model: 'opus',
        provider: 'claude',
        permissionMode: 'autoEdit',
        worktreePath: '/tmp/worktree-1',
      })),
      dequeueMessage: vi.fn(async () => entry),
      queueCount: vi.fn(async () => 0),
      peekMessage: vi.fn(async () => null),
    });

    await agentCompletedQueueHandler.action(makeEvent(), ctx);

    // cwd (3rd arg) should be worktreePath, not project.path
    expect(ctx.startAgent).toHaveBeenCalled();
    const callArgs = (ctx.startAgent as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(callArgs[2]).toBe('/tmp/worktree-1');
  });

  test('uses message-level overrides for model/provider/permissionMode', async () => {
    const entry = makeQueueEntry({
      content: 'Use sonnet',
      model: 'sonnet',
      provider: 'openai',
      permissionMode: 'manual',
      images: '[{"type":"base64","data":"abc"}]',
      disallowedTools: '["Bash"]',
      allowedTools: '["Read"]',
    });
    const ctx = makeCtx({
      dequeueMessage: vi.fn(async () => entry),
      queueCount: vi.fn(async () => 0),
      peekMessage: vi.fn(async () => null),
    });

    await agentCompletedQueueHandler.action(makeEvent(), ctx);

    expect(ctx.startAgent).toHaveBeenCalledWith(
      't-1',
      'Use sonnet',
      '/projects/test',
      'sonnet', // message-level model
      'manual', // message-level permissionMode
      [{ type: 'base64', data: 'abc' }], // parsed images
      ['Bash'], // parsed disallowedTools
      ['Read'], // parsed allowedTools
      'openai', // message-level provider
      true,
    );
  });

  test('works with followUpMode "ask"', async () => {
    const entry = makeQueueEntry();
    const ctx = makeCtx({
      getProject: vi.fn(async () => ({ id: 'p-1', path: '/test', followUpMode: 'ask' })),
      dequeueMessage: vi.fn(async () => entry),
      queueCount: vi.fn(async () => 0),
      peekMessage: vi.fn(async () => null),
    });

    await agentCompletedQueueHandler.action(makeEvent(), ctx);

    expect(ctx.startAgent).toHaveBeenCalled();
  });

  // ── Queue update emission ───────────────────────────────

  test('emits queue update event to user after starting agent', async () => {
    const entry = makeQueueEntry({ content: 'Hello queue' });
    const nextEntry = makeQueueEntry({ id: 'q-2', content: 'Next in line', sortOrder: 1 });
    const ctx = makeCtx({
      dequeueMessage: vi.fn(async () => entry),
      queueCount: vi.fn(async () => 1),
      peekMessage: vi.fn(async () => nextEntry),
    });

    await agentCompletedQueueHandler.action(makeEvent(), ctx);

    expect(ctx.emitToUser).toHaveBeenCalledWith('u-1', {
      type: 'thread:queue_update',
      threadId: 't-1',
      data: {
        threadId: 't-1',
        queuedCount: 1,
        nextMessage: 'Next in line',
        dequeuedMessage: 'Hello queue',
        dequeuedImages: undefined,
      },
    });
  });

  test('broadcasts queue update when thread has no userId', async () => {
    const entry = makeQueueEntry();
    const ctx = makeCtx({
      getThread: vi.fn(async () => ({
        id: 't-1',
        projectId: 'p-1',
        userId: '', // falsy userId
        model: 'opus',
        provider: 'claude',
        permissionMode: 'autoEdit',
        worktreePath: null,
      })),
      dequeueMessage: vi.fn(async () => entry),
      queueCount: vi.fn(async () => 0),
      peekMessage: vi.fn(async () => null),
    });

    await agentCompletedQueueHandler.action(makeEvent(), ctx);

    expect(ctx.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'thread:queue_update' }),
    );
    expect(ctx.emitToUser).not.toHaveBeenCalled();
  });

  // ── Error recovery (re-enqueue) ─────────────────────────

  test('re-enqueues message when startAgent fails', async () => {
    const entry = makeQueueEntry({
      content: 'Will fail',
      provider: 'claude',
      model: 'haiku',
      permissionMode: 'manual',
      images: '[{"type":"url"}]',
      allowedTools: '["Read"]',
      disallowedTools: '["Bash"]',
      fileReferences: '["file.ts"]',
    });
    const ctx = makeCtx({
      dequeueMessage: vi.fn(async () => entry),
      startAgent: vi.fn(async () => {
        throw new Error('Agent spawn failed');
      }),
    });

    await agentCompletedQueueHandler.action(makeEvent(), ctx);

    expect(ctx.enqueueMessage).toHaveBeenCalledWith('t-1', {
      content: 'Will fail',
      provider: 'claude',
      model: 'haiku',
      permissionMode: 'manual',
      images: '[{"type":"url"}]',
      allowedTools: '["Read"]',
      disallowedTools: '["Bash"]',
      fileReferences: '["file.ts"]',
    });
  });

  test('logs critical error when re-enqueue also fails', async () => {
    const entry = makeQueueEntry({ id: 'q-fail' });
    const ctx = makeCtx({
      dequeueMessage: vi.fn(async () => entry),
      startAgent: vi.fn(async () => {
        throw new Error('Agent spawn failed');
      }),
      enqueueMessage: vi.fn(async () => {
        throw new Error('DB write failed');
      }),
    });

    // Should not throw — handler catches both errors
    await agentCompletedQueueHandler.action(makeEvent(), ctx);

    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining('CRITICAL'));
  });

  // ── Default follow-up mode ──────────────────────────────

  test('uses default follow-up mode when project has none set', async () => {
    // Default follow-up mode is 'queue', so handler should still try to dequeue
    const ctx = makeCtx({
      getProject: vi.fn(async () => ({ id: 'p-1', path: '/test', followUpMode: undefined })),
      dequeueMessage: vi.fn(async () => null),
    });

    await agentCompletedQueueHandler.action(makeEvent(), ctx);

    // With default 'queue' mode, dequeue should be called
    expect(ctx.dequeueMessage).toHaveBeenCalledWith('t-1');
  });
});
