import { beforeEach, describe, expect, test } from 'bun:test';

import { agentCompletedQueueHandler } from '../../services/handlers/agent-completed-queue-handler.js';
import type { RuntimeThreadRecord } from '../../services/server-interfaces.js';
import { scratchPathFor } from '../../services/thread-context.js';
import { cleanupThreadActor } from '../../services/thread-status-machine.js';
/**
 * Start failures that happen before the agent process exists (#234), over a
 * real `AgentLifecycleManager` whose thread row lives in memory.
 *
 * Whatever phase fails (working directory, agent profile, project secrets,
 * scratch directory), `startAgent` must resolve to an `Err` (never reject),
 * spawn nothing, leave the thread `failed` with the reason sent to its owner,
 * and leave nothing behind (run span, redactor) that stops the next start.
 * A queued follow-up whose start fails must stay in the queue.
 */
import { edges, createStartHarness, resetEdges } from '../helpers/agent-start-harness.js';

const THREAD_ID = 'thread-early';
const OWNER = 'user-1';
const PROJECT = { id: 'proj-1', path: '/tmp/repo', systemPrompt: null, followUpMode: 'queue' };

interface EarlyFailure {
  phase: string;
  thread: Partial<RuntimeThreadRecord>;
  /** Make the phase fail; the harness's `resetEdges` makes it work again. */
  breakPhase: () => void;
  /** Undo what `breakPhase` changed on the thread row, for the retry. */
  repairThread?: Partial<RuntimeThreadRecord>;
  error: string;
  /** Whether the failure comes after the running status and the run span. */
  afterRunSpan: boolean;
}

const failures: EarlyFailure[] = [
  {
    phase: 'working directory (worktree thread without a worktree)',
    thread: { mode: 'worktree', worktreePath: null },
    breakPhase: () => {},
    repairThread: { worktreePath: '/tmp/repo/.worktrees/feature' },
    error: 'worktreePath',
    afterRunSpan: false,
  },
  {
    phase: 'agent profile resolution',
    thread: {},
    breakPhase: () =>
      edges.resolveEffectiveProfile.mockImplementation(async () => {
        throw new Error('profile lookup timed out');
      }),
    error: 'profile lookup timed out',
    afterRunSpan: false,
  },
  {
    phase: 'project secrets',
    thread: {},
    breakPhase: () =>
      edges.getProjectSecrets.mockImplementation(async () => ({
        error: 'undecryptable',
        message: 'The project secret API_KEY cannot be decrypted.',
      })),
    error: 'API_KEY cannot be decrypted',
    afterRunSpan: true,
  },
  {
    phase: 'scratch directory creation',
    thread: { projectId: '', isScratch: true },
    breakPhase: () =>
      edges.mkdirSync.mockImplementation((path: unknown) => {
        if (path === scratchPathFor(OWNER, THREAD_ID)) throw new Error('ENOSPC: no space left');
        return undefined;
      }),
    error: 'ENOSPC',
    afterRunSpan: false,
  },
];

function setup(thread: Partial<RuntimeThreadRecord>) {
  const h = createStartHarness();
  h.seedThread({ id: THREAD_ID, userId: OWNER, status: 'completed', ...thread });
  edges.getProject.mockImplementation(async (id: string) =>
    id === 'proj-1' ? PROJECT : undefined,
  );
  return h;
}

function start(h: ReturnType<typeof createStartHarness>) {
  return h.lifecycle.startAgent(THREAD_ID, 'hello', '/tmp/repo', 'sonnet', 'autoEdit');
}

describe('startAgent — failures before the agent process exists (#234)', () => {
  beforeEach(() => {
    resetEdges();
    cleanupThreadActor(THREAD_ID);
  });

  describe.each(failures)('$phase', (failure) => {
    test('resolves to an Err, spawns nothing and marks the thread failed', async () => {
      const h = setup(failure.thread);
      failure.breakPhase();

      // `startAgent` never rejects: awaiting it here would throw if it did.
      const result = await start(h);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) expect(result.error.message).toContain(failure.error);

      expect(edges.spawn).not.toHaveBeenCalled();
      expect(edges.threadEventBusEmit).not.toHaveBeenCalledWith('agent:started', expect.anything());
      expect(h.threads.get(THREAD_ID)?.status).toBe('failed');
      expect(h.threads.get(THREAD_ID)?.completedAt).toEqual(expect.any(String));

      const errors = h.eventsOf(THREAD_ID, 'agent:error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({ userId: OWNER });
      expect(errors[0].data.error).toContain(failure.error);
      expect(h.eventsOf(THREAD_ID, 'agent:status').at(-1)?.data).toEqual({ status: 'failed' });

      // The run span is closed if it was opened, and never left in the map.
      if (failure.afterRunSpan) {
        expect(edges.startSpan).toHaveBeenCalledTimes(1);
        expect(edges.spanEnd).toHaveBeenCalledWith('error', expect.stringContaining(failure.error));
      } else {
        expect(edges.startSpan).not.toHaveBeenCalled();
      }
      expect(h.lifecycle.getRunSpans().size).toBe(0);
    });

    test('leaves nothing behind: the next start runs the agent', async () => {
      const h = setup(failure.thread);
      failure.breakPhase();
      expect((await start(h)).isErr()).toBe(true);

      resetEdges();
      edges.getProject.mockImplementation(async (id: string) =>
        id === 'proj-1' ? PROJECT : undefined,
      );
      if (failure.repairThread) {
        h.threads.set(THREAD_ID, { ...h.threads.get(THREAD_ID)!, ...failure.repairThread });
      }

      const retried = await start(h);

      expect(retried.isOk()).toBe(true);
      expect(edges.spawn).toHaveBeenCalledTimes(1);
      expect(h.threads.get(THREAD_ID)?.status).toBe('running');
      expect(h.eventsOf(THREAD_ID, 'agent:status').at(-1)?.data).toMatchObject({
        status: 'running',
      });
      expect(edges.threadEventBusEmit).toHaveBeenCalledWith(
        'agent:started',
        expect.objectContaining({ threadId: THREAD_ID }),
      );
      expect(h.lifecycle.getRunSpans().size).toBe(1);
    });
  });

  test('a queued follow-up whose start fails early stays queued, then runs on the next drain', async () => {
    const h = setup({});
    h.enqueue(THREAD_ID, 'queued follow-up', { model: 'opus', disallowedTools: '["Bash"]' });
    edges.getProjectSecrets.mockImplementation(async () => ({
      error: 'unreachable',
      message: 'The server did not answer.',
    }));

    const completed = {
      threadId: THREAD_ID,
      projectId: 'proj-1',
      userId: OWNER,
      worktreePath: null,
      cwd: '/tmp/repo',
      status: 'completed' as const,
      cost: 0,
    };
    await agentCompletedQueueHandler.action(completed, h.handlerCtx);

    expect(edges.spawn).not.toHaveBeenCalled();
    expect(h.threads.get(THREAD_ID)?.status).toBe('failed');
    // Not lost and not reported sent: it is back in the queue with its settings.
    expect(h.queues.get(THREAD_ID)).toEqual([
      expect.objectContaining({
        content: 'queued follow-up',
        model: 'opus',
        disallowedTools: '["Bash"]',
      }),
    ]);
    expect(h.handlerCtx.emitToUser).not.toHaveBeenCalled();

    edges.getProjectSecrets.mockImplementation(async () => ({ secrets: [] }));
    await agentCompletedQueueHandler.action(completed, h.handlerCtx);

    expect(edges.spawn).toHaveBeenCalledTimes(1);
    expect(edges.spawn.mock.calls[0][0]).toMatchObject({
      cwd: '/tmp/repo',
      model: 'opus',
      prompt: expect.stringContaining('queued follow-up'),
    });
    expect(h.queues.get(THREAD_ID)).toEqual([]);
    expect(h.threads.get(THREAD_ID)?.status).toBe('running');
  });
});
