/**
 * Pipeline orchestration tests.
 *
 * Tests the review-fix pipeline flow via startPipelineRun and the
 * pipeline engine. The new architecture uses git-pipelines.ts for
 * the review-fix sub-pipeline, which startPipelineRun lazy-imports.
 */
import { okAsync } from 'neverthrow';
import { describe, test, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────

const mockEmitToUser = vi.fn();

const serviceMocks = vi.hoisted(() => ({
  createRun: vi.fn().mockResolvedValue('run-1'),
  updateRun: vi.fn().mockResolvedValue(undefined),
  getProject: vi.fn(),
}));

vi.mock('bun:sqlite', () => ({ Database: vi.fn() }));
vi.mock('nanoid', () => {
  let counter = 0;
  return { nanoid: () => `mock-id-${++counter}` };
});
vi.mock('../../db/index.js', () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          all: vi.fn(() => []),
          get: vi.fn(() => undefined),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        run: vi.fn(),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn(() => ({
        where: vi.fn(() => ({
          run: vi.fn(),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        run: vi.fn(),
      })),
    })),
  },
  dbRun: vi.fn(),
}));
vi.mock('../../services/thread-service/create.js', () => ({
  createAndStartThread: vi.fn(),
}));
vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: {
    emitToUser: (...args: any[]) => mockEmitToUser(...args),
    broadcast: vi.fn(),
  },
}));
vi.mock('../../services/service-registry.js', () => ({
  getServices: () => ({
    pipelines: {
      createRun: serviceMocks.createRun,
      updateRun: serviceMocks.updateRun,
      getRunById: vi.fn(),
      getRunsForThread: vi.fn().mockReturnValue([]),
      getPipelineForProject: vi.fn(),
      createPipeline: vi.fn(),
      getPipelineById: vi.fn(),
      getPipelinesByProject: vi.fn(),
      updatePipeline: vi.fn(),
      deletePipeline: vi.fn(),
    },
    wsBroker: {
      emitToUser: (...args: any[]) => mockEmitToUser(...args),
      broadcast: vi.fn(),
    },
    projects: {
      getProject: serviceMocks.getProject,
    },
    automations: {
      getAutomation: vi.fn(),
    },
  }),
}));
vi.mock('../../services/pipeline-adapter.js', () => {
  return {
    RuntimeActionProvider: class {
      spawnAgent = vi.fn().mockResolvedValue({ ok: true, output: '' });
      runCommand = vi.fn().mockResolvedValue({ ok: true, output: '' });
      gitCommit = vi.fn().mockResolvedValue({ ok: true, output: '' });
      gitPush = vi.fn().mockResolvedValue({ ok: true, output: '' });
      createPr = vi.fn().mockResolvedValue({ ok: true, output: '' });
      notify = vi.fn().mockResolvedValue({ ok: true });
      setStatus = vi.fn().mockResolvedValue({ ok: true });
      setStage = vi.fn().mockResolvedValue({ ok: true });
      requestApproval = vi.fn().mockResolvedValue({ decision: 'approve' });
    },
    RuntimeProgressReporter: class {
      onStepProgress = vi.fn();
      onPipelineEvent = vi.fn();
    },
  };
});
vi.mock('../../services/agent-registry.js', () => ({
  BUILTIN_AGENTS: {
    reviewer: {
      name: 'reviewer',
      label: 'Code Reviewer',
      systemPrompt: 'Review code',
      model: 'sonnet',
      provider: 'claude',
      permissionMode: 'plan',
    },
    corrector: {
      name: 'corrector',
      label: 'Code Corrector',
      systemPrompt: 'Fix code',
      model: 'sonnet',
      provider: 'claude',
      permissionMode: 'autoEdit',
    },
  },
  resolveAgent: (_base: any, overrides: any) => ({ ..._base, ...overrides }),
  resolveSystemPrompt: (agent: any) =>
    typeof agent.systemPrompt === 'function' ? agent.systemPrompt({}) : agent.systemPrompt,
}));
vi.mock('../../services/thread-manager.js', () => ({
  getThread: vi.fn(),
  getThreadWithMessages: vi.fn(),
  updateThread: vi.fn(),
}));
vi.mock('../../services/project-manager.js', () => ({
  getProject: vi.fn(),
}));
vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/agent-runner.js', () => ({
  startAgent: vi.fn(),
  isAgentRunning: vi.fn(() => false),
}));
vi.mock('@funny/core/git', () => ({
  gitRead: vi.fn(),
  gitWrite: vi.fn(),
  removeWorktree: vi.fn().mockReturnValue(okAsync(undefined)),
  removeBranch: vi.fn().mockReturnValue(okAsync(undefined)),
}));
vi.mock('../../services/git-service.js', () => ({
  commitChanges: vi.fn(),
  resolveIdentity: vi.fn(),
}));
vi.mock('../../services/thread-event-bus.js', () => ({
  threadEventBus: {
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));
// Mock git-pipelines.ts — startPipelineRun lazy-imports reviewFixSubPipeline from it.
// Provide a trivial pipeline that completes immediately.
vi.mock('../../services/git-pipelines.js', () => {
  // Inline a minimal pipeline definition so we don't import the real one
  return {
    reviewFixSubPipeline: {
      name: 'review-fix',
      nodes: [
        {
          name: 'review-noop',
          execute: async (ctx: any) => ({ ...ctx, verdict: 'pass' }),
        },
      ],
    },
  };
});

import {
  startPipelineRun,
  cancelPipelineRun,
  cleanupReviewerThread,
  type PipelineConfig,
} from '../../services/pipeline-manager.js';
import * as tm from '../../services/thread-manager.js';

// ── Helpers ──────────────────────────────────────────────────

function makePipeline(overrides: Partial<PipelineConfig> = {}): PipelineConfig {
  return {
    id: 'pipe-1',
    projectId: 'proj-1',
    userId: 'user-1',
    name: 'Default Pipeline',
    enabled: true,
    reviewModel: 'sonnet',
    fixModel: 'sonnet',
    maxIterations: 10,
    precommitFixEnabled: false,
    precommitFixModel: 'sonnet',
    precommitFixMaxIterations: 3,
    testEnabled: false,
    testFixEnabled: false,
    testFixModel: 'sonnet',
    testFixMaxIterations: 3,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('Pipeline Orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ══════════════════════════════════════════════════════════
  // startPipelineRun
  // ══════════════════════════════════════════════════════════

  describe('startPipelineRun', () => {
    test('emits pipeline:run_started WS event', async () => {
      const pipeline = makePipeline();

      await startPipelineRun({
        pipeline,
        threadId: 'thread-1',
        userId: 'user-1',
        projectId: 'proj-1',
        commitSha: 'abc123',
        cwd: '/tmp/repo',
      });

      // Wait for fire-and-forget pipeline to complete (uses mocked noop pipeline)
      await new Promise((r) => setTimeout(r, 50));

      expect(mockEmitToUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          type: 'pipeline:run_started',
          threadId: 'thread-1',
          data: expect.objectContaining({
            pipelineId: 'pipe-1',
            threadId: 'thread-1',
            commitSha: 'abc123',
          }),
        }),
      );
    });

    test('skips trigger for pipeline commits', async () => {
      const pipeline = makePipeline();

      await startPipelineRun({
        pipeline,
        threadId: 'thread-1',
        userId: 'user-1',
        projectId: 'proj-1',
        commitSha: 'sha456',
        cwd: '/tmp/repo',
        isPipelineCommit: true,
        pipelineRunId: 'existing-run',
      });

      expect(mockEmitToUser).not.toHaveBeenCalled();
    });

    test('emits pipeline:run_completed after pipeline finishes', async () => {
      const pipeline = makePipeline();

      await startPipelineRun({
        pipeline,
        threadId: 'thread-1',
        userId: 'user-1',
        projectId: 'proj-1',
        cwd: '/tmp/repo',
      });

      // Wait for fire-and-forget pipeline to complete
      await new Promise((r) => setTimeout(r, 100));

      const completedCalls = mockEmitToUser.mock.calls.filter(
        (call: any[]) => call[1]?.type === 'pipeline:run_completed',
      );
      expect(completedCalls.length).toBeGreaterThanOrEqual(1);
    });

    test('cancelPipelineRun aborts an in-flight run', async () => {
      const pipeline = makePipeline();

      await startPipelineRun({
        pipeline,
        threadId: 'thread-1',
        userId: 'user-1',
        projectId: 'proj-1',
        cwd: '/tmp/repo',
      });

      expect(cancelPipelineRun('run-1')).toBe(true);

      await new Promise((r) => setTimeout(r, 150));
      expect(cancelPipelineRun('run-1')).toBe(false);
    });
  });

  describe('cleanupReviewerThread', () => {
    beforeEach(() => {
      serviceMocks.getProject.mockResolvedValue({
        id: 'proj-1',
        path: '/tmp/repo',
      });
    });

    test('no-ops when reviewer thread is missing', async () => {
      vi.mocked(tm.getThread).mockResolvedValue(undefined);

      await cleanupReviewerThread('missing', 'proj-1');

      expect(tm.updateThread).not.toHaveBeenCalled();
    });

    test('no-ops when project is missing', async () => {
      vi.mocked(tm.getThread).mockResolvedValue({
        id: 'rev-1',
        mode: 'worktree',
        worktreePath: '/tmp/repo/.worktrees/rev',
        branch: 'review/fix',
      });
      serviceMocks.getProject.mockResolvedValue(undefined);

      await cleanupReviewerThread('rev-1', 'proj-1');

      expect(tm.updateThread).not.toHaveBeenCalled();
    });

    test('archives reviewer worktree and removes git artifacts', async () => {
      vi.mocked(tm.getThread).mockResolvedValue({
        id: 'rev-1',
        mode: 'worktree',
        worktreePath: '/tmp/repo/.worktrees/rev',
        branch: 'review/fix',
      });

      await cleanupReviewerThread('rev-1', 'proj-1');

      const { removeWorktree, removeBranch } = await import('@funny/core/git');
      expect(removeWorktree).toHaveBeenCalledWith('/tmp/repo', '/tmp/repo/.worktrees/rev');
      expect(removeBranch).toHaveBeenCalledWith('/tmp/repo', 'review/fix');
      expect(tm.updateThread).toHaveBeenCalledWith('rev-1', {
        archived: 1,
        worktreePath: null,
        branch: null,
      });
    });

    test('archives local reviewer thread without git cleanup', async () => {
      vi.mocked(tm.getThread).mockResolvedValue({
        id: 'rev-local',
        mode: 'local',
        worktreePath: null,
        branch: 'main',
      });

      await cleanupReviewerThread('rev-local', 'proj-1');

      const { removeWorktree } = await import('@funny/core/git');
      expect(removeWorktree).not.toHaveBeenCalled();
      expect(tm.updateThread).toHaveBeenCalledWith('rev-local', {
        archived: 1,
        worktreePath: null,
        branch: null,
      });
    });
  });

  // ══════════════════════════════════════════════════════════
  // Pipeline Engine (unit tests)
  // ══════════════════════════════════════════════════════════

  describe('Pipeline Engine', () => {
    test('definePipeline and runPipeline work for simple sequential pipeline', async () => {
      const { definePipeline, node, runPipeline } = await import('@funny/pipelines/engine');

      const pipeline = definePipeline<{ value: number }>({
        name: 'test',
        nodes: [
          node('double', async (ctx) => ({ ...ctx, value: ctx.value * 2 })),
          node('add-one', async (ctx) => ({ ...ctx, value: ctx.value + 1 })),
        ],
      });

      const result = await runPipeline(pipeline, { value: 5 });
      expect(result.ctx.value).toBe(11);
      expect(result.outcome).toBe('completed');
    });

    test('node with when=false is skipped', async () => {
      const { definePipeline, node, runPipeline } = await import('@funny/pipelines/engine');

      const fn = vi.fn(async (ctx: { value: number }) => ({
        ...ctx,
        value: ctx.value + 100,
      }));

      const pipeline = definePipeline<{ value: number }>({
        name: 'test-skip',
        nodes: [
          node('always', async (ctx) => ({ ...ctx, value: ctx.value + 1 })),
          node('never', fn, { when: () => false }),
        ],
      });

      const result = await runPipeline(pipeline, { value: 0 });
      expect(result.ctx.value).toBe(1);
      expect(fn).not.toHaveBeenCalled();
    });

    test('pipeline loop repeats until condition met', async () => {
      const { definePipeline, node, runPipeline } = await import('@funny/pipelines/engine');

      const pipeline = definePipeline<{ count: number }>({
        name: 'test-loop',
        nodes: [node('increment', async (ctx) => ({ ...ctx, count: ctx.count + 1 }))],
        loop: {
          from: 'increment',
          until: (ctx) => ctx.count >= 3,
        },
      });

      const result = await runPipeline(pipeline, { count: 0 });
      expect(result.ctx.count).toBe(3);
    });

    test('pipeline respects maxIterations', async () => {
      const { definePipeline, node, runPipeline } = await import('@funny/pipelines/engine');

      const pipeline = definePipeline<{ count: number }>({
        name: 'test-max-iter',
        nodes: [node('increment', async (ctx) => ({ ...ctx, count: ctx.count + 1 }))],
        loop: {
          from: 'increment',
          until: () => false,
        },
      });

      const result = await runPipeline(pipeline, { count: 0 }, { maxIterations: 5 });
      expect(result.ctx.count).toBe(5);
      expect(result.outcome).toBe('failed');
    });

    test('pipeline cancellation via AbortSignal', async () => {
      const { definePipeline, node, runPipeline } = await import('@funny/pipelines/engine');

      const controller = new AbortController();

      const pipeline = definePipeline<{ count: number }>({
        name: 'test-cancel',
        nodes: [
          node('slow', async (ctx) => {
            if (ctx.count >= 1) controller.abort();
            return { ...ctx, count: ctx.count + 1 };
          }),
        ],
        loop: {
          from: 'slow',
          until: () => false,
        },
      });

      const result = await runPipeline(
        pipeline,
        { count: 0 },
        { signal: controller.signal, maxIterations: 100 },
      );
      expect(result.outcome).toBe('cancelled');
      expect(result.ctx.count).toBeLessThanOrEqual(2);
    });

    test('pipeline onStateChange reports entering, completed, and terminal', async () => {
      const { definePipeline, node, runPipeline } = await import('@funny/pipelines/engine');

      const changes: any[] = [];

      const pipeline = definePipeline<{ value: number }>({
        name: 'test-state-change',
        nodes: [
          node('step-a', async (ctx) => ({ ...ctx, value: ctx.value + 1 })),
          node('step-b', async (ctx) => ({ ...ctx, value: ctx.value + 2 })),
        ],
      });

      await runPipeline(
        pipeline,
        { value: 0 },
        {
          onStateChange: (change) => changes.push(change),
        },
      );

      const entering = changes.filter((c) => c.kind === 'entering');
      const completed = changes.filter((c) => c.kind === 'completed');
      const terminal = changes.filter((c) => c.kind === 'terminal');

      expect(entering.length).toBe(2);
      expect(completed.length).toBe(2);
      expect(terminal.length).toBe(1);
      expect(terminal[0].outcome).toBe('completed');
    });

    test('pipeline onStateChange reports error on node failure', async () => {
      const { definePipeline, node, runPipeline } = await import('@funny/pipelines/engine');

      const changes: any[] = [];

      const pipeline = definePipeline<{ value: number }>({
        name: 'test-error',
        nodes: [
          node('will-fail', async () => {
            throw new Error('boom');
          }),
        ],
      });

      await runPipeline(
        pipeline,
        { value: 0 },
        {
          onStateChange: (change) => changes.push(change),
        },
      );

      const terminal = changes.find((c: any) => c.kind === 'terminal');
      expect(terminal).toBeTruthy();
      expect(terminal.outcome).toBe('failed');
      expect(terminal.error).toContain('boom');
    });

    test('compose merges node arrays into flat list', async () => {
      const { compose, node } = await import('@funny/pipelines/engine');

      const group1 = [node<{ v: number }>('a', async (ctx) => ctx)];
      const group2 = [
        node<{ v: number }>('b', async (ctx) => ctx),
        node<{ v: number }>('c', async (ctx) => ctx),
      ];

      const result = compose(group1, group2);
      expect(result).toHaveLength(3);
      expect(result.map((n) => n.name)).toEqual(['a', 'b', 'c']);
    });
  });
});
