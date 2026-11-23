import { beforeEach, describe, expect, test } from 'bun:test';

import { agentCompletedQueueHandler } from '../../services/handlers/agent-completed-queue-handler.js';
import { scratchPathFor } from '../../services/thread-context.js';
import type { AgentCompletedEvent } from '../../services/thread-event-bus.js';
import { cleanupThreadActor } from '../../services/thread-status-machine.js';
/**
 * Draining a scratch thread's follow-up queue end to end (#234): the queue
 * handler over a real `AgentLifecycleManager`, as `init-runtime.ts` wires it.
 *
 * A scratch thread has no project, no git and its own directory
 * (`scratchPathFor`). When its agent completes, the next queued message must
 * start in that directory without a project lookup or any git work, and a
 * start that fails must leave the message in the queue for the next drain.
 * `agent-completed-queue-handler.test.ts` covers the handler alone, with a
 * stubbed `startAgent`.
 */
import { edges, createStartHarness, resetEdges } from '../helpers/agent-start-harness.js';

const SCRATCH_ID = 'scratch-q1';
const OWNER = 'user-1';
const scratchCwd = scratchPathFor(OWNER, SCRATCH_ID);

function completed(threadId = SCRATCH_ID): AgentCompletedEvent {
  return {
    threadId,
    projectId: '',
    userId: OWNER,
    worktreePath: null,
    cwd: scratchPathFor(OWNER, threadId),
    status: 'completed',
    cost: 0,
  };
}

function setup() {
  const h = createStartHarness();
  h.seedThread({ id: SCRATCH_ID, userId: OWNER, projectId: '', isScratch: true });
  return h;
}

/** The scratch directory, and only that path, cannot be created. */
function failScratchMkdir() {
  edges.mkdirSync.mockImplementation((path: unknown) => {
    if (path === scratchCwd) throw new Error('EACCES: permission denied');
    return undefined;
  });
}

describe('scratch thread queue drain (#234)', () => {
  beforeEach(() => {
    resetEdges();
    cleanupThreadActor(SCRATCH_ID);
  });

  test('starts the next queued message in the scratch directory, with no project and no git', async () => {
    const h = setup();
    h.enqueue(SCRATCH_ID, 'first follow-up', { model: 'opus' });
    h.enqueue(SCRATCH_ID, 'second follow-up');

    await agentCompletedQueueHandler.action(completed(), h.handlerCtx);

    // One process, in the scratch directory, created just before.
    expect(edges.spawn).toHaveBeenCalledTimes(1);
    const opts = edges.spawn.mock.calls[0][0];
    expect(opts.cwd).toBe(scratchCwd);
    expect(opts.model).toBe('opus');
    expect(edges.mkdirSync).toHaveBeenCalledWith(scratchCwd, { recursive: true });
    expect(h.threads.get(SCRATCH_ID)?.status).toBe('running');

    // No project and no git anywhere in the drain or the start.
    expect(edges.getProject).not.toHaveBeenCalled();
    expect(edges.getProjectSecrets).not.toHaveBeenCalled();
    expect(edges.captureGitCheckpoint).not.toHaveBeenCalled();
    expect(edges.getDiffSummary).not.toHaveBeenCalled();
    expect(edges.syncClaudeProjectAssets).not.toHaveBeenCalled();
    expect(h.handlerCtx.getGitStatusSummary).not.toHaveBeenCalled();

    // Only the first message is sent; it lands in the thread, the second waits.
    expect(h.insertedMessages).toEqual([{ threadId: SCRATCH_ID, content: 'first follow-up' }]);
    expect(h.queues.get(SCRATCH_ID)?.map((m) => m.content)).toEqual(['second follow-up']);
    expect(h.handlerCtx.emitToUser).toHaveBeenCalledWith(OWNER, {
      type: 'thread:queue_update',
      threadId: SCRATCH_ID,
      data: expect.objectContaining({
        queuedCount: 1,
        nextMessage: 'second follow-up',
        dequeuedMessage: 'first follow-up',
      }),
    });
  });

  test('an empty queue starts nothing and leaves the thread completed', async () => {
    const h = setup();

    await agentCompletedQueueHandler.action(completed(), h.handlerCtx);

    expect(edges.spawn).not.toHaveBeenCalled();
    expect(edges.mkdirSync).not.toHaveBeenCalled();
    expect(edges.getProject).not.toHaveBeenCalled();
    expect(h.insertedMessages).toEqual([]);
    expect(h.threads.get(SCRATCH_ID)?.status).toBe('completed');
    expect(h.handlerCtx.emitToUser).not.toHaveBeenCalled();
  });

  test('a start that fails early keeps the message queued, and the next drain sends it', async () => {
    const h = setup();
    h.enqueue(SCRATCH_ID, 'retry me', { model: 'haiku', allowedTools: '["Read"]' });
    failScratchMkdir();

    await agentCompletedQueueHandler.action(completed(), h.handlerCtx);

    // Nothing spawned; the thread shows the failure instead of staying `running`.
    expect(edges.spawn).not.toHaveBeenCalled();
    expect(h.threads.get(SCRATCH_ID)?.status).toBe('failed');
    expect(h.eventsOf(SCRATCH_ID, 'agent:error')).toEqual([
      expect.objectContaining({ data: { error: 'EACCES: permission denied' } }),
    ]);
    expect(h.eventsOf(SCRATCH_ID, 'agent:status').at(-1)?.data).toEqual({ status: 'failed' });
    expect(h.lifecycle.getRunSpans().size).toBe(0);

    // The message is back in the queue with its settings, and not reported sent.
    expect(h.queues.get(SCRATCH_ID)).toEqual([
      expect.objectContaining({ content: 'retry me', model: 'haiku', allowedTools: '["Read"]' }),
    ]);
    expect(h.handlerCtx.emitToUser).not.toHaveBeenCalled();

    // The directory can be created again: the next drain sends the same message.
    edges.mkdirSync.mockImplementation(() => undefined);
    await agentCompletedQueueHandler.action(completed(), h.handlerCtx);

    expect(edges.spawn).toHaveBeenCalledTimes(1);
    expect(edges.spawn.mock.calls[0][0]).toMatchObject({ cwd: scratchCwd, model: 'haiku' });
    expect(h.threads.get(SCRATCH_ID)?.status).toBe('running');
    expect(h.queues.get(SCRATCH_ID)).toEqual([]);
  });

  test('a scratch thread whose ids fail the path check is not drained', async () => {
    const h = createStartHarness();
    h.seedThread({ id: SCRATCH_ID, userId: '../escape', projectId: '', isScratch: true });
    h.enqueue(SCRATCH_ID, 'stay queued');

    await agentCompletedQueueHandler.action(completed(), h.handlerCtx);

    expect(edges.spawn).not.toHaveBeenCalled();
    expect(edges.mkdirSync).not.toHaveBeenCalled();
    expect(h.queues.get(SCRATCH_ID)?.map((m) => m.content)).toEqual(['stay queued']);
    expect(h.threads.get(SCRATCH_ID)?.status).toBe('completed');
  });
});
