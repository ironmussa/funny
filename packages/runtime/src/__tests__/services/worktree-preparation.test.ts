import { describe, test, expect, vi, beforeEach } from 'bun:test';

const mocks = (() => ({
  createWorktree: vi.fn(),
  setupWorktree: vi.fn(),
  emitToUser: vi.fn(),
  spans: [] as Array<{
    name: string;
    attributes: Record<string, unknown>;
    status?: string;
    error?: string;
    parentSpanId?: string;
  }>,
  histograms: [] as Array<{ name: string; attributes?: Record<string, unknown> }>,
}))();

vi.mock('@funny/core/git', () => ({
  createWorktree: mocks.createWorktree,
  configuredWorktreeRoot: () => '/fast',
}));
vi.mock('@funny/core/ports', () => ({ setupWorktree: mocks.setupWorktree }));
vi.mock('../../lib/logger.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../services/ws-broker.js', () => ({
  wsBroker: { emit: vi.fn(), emitToUser: mocks.emitToUser },
}));
vi.mock('../../lib/telemetry.js', () => {
  let n = 0;
  return {
    startSpan: (
      name: string,
      opts?: { parentSpanId?: string; attributes?: Record<string, unknown> },
    ) => {
      const spanId = `s${++n}`;
      const handle = {
        traceId: 't1',
        spanId,
        name,
        attributes: { ...opts?.attributes },
        durationMs: 0,
        end(status?: string, error?: string) {
          mocks.spans.push({
            name: handle.name,
            attributes: handle.attributes,
            status,
            error,
            parentSpanId: opts?.parentSpanId,
          });
        },
      };
      return handle;
    },
    recordHistogram: (name: string, _value: number, opts?: { attributes?: object }) => {
      mocks.histograms.push({ name, attributes: opts?.attributes as Record<string, unknown> });
    },
  };
});

import { err, ok } from 'neverthrow';

import { prepareWorktree } from '../../services/thread-service/worktree-preparation.js';

const params = {
  projectPath: '/repo',
  branchName: 'app/feature-abc123',
  baseBranch: 'master',
  userId: 'u-1',
  threadId: 't-1',
  flow: 'create' as const,
};

type Progress = (step: string, label: string, status: string, error?: string) => void;

describe('prepareWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.spans.length = 0;
    mocks.histograms.length = 0;
  });

  test('records a span per phase and per setup step, and still forwards progress', async () => {
    mocks.createWorktree.mockImplementation(async (...args: unknown[]) => {
      const onProgress = args[3] as Progress;
      onProgress('worktree:create', 'Creating worktree', 'running');
      onProgress('worktree:create', 'Creating worktree', 'completed');
      return ok('/fast/.funny-worktrees/repo-1/wt');
    });
    mocks.setupWorktree.mockImplementation(async (...args: unknown[]) => {
      const onProgress = args[2] as Progress;
      onProgress('cmd:bun install', 'bun install', 'running');
      onProgress('cmd:bun install', 'bun install', 'completed');
      onProgress('cmd:false', 'false', 'running');
      onProgress('cmd:false', 'false', 'failed', 'exit 1');
      return ok({ ports: [], postCreateErrors: ['"false": exit 1'] });
    });

    const result = await prepareWorktree(params);

    expect(result._unsafeUnwrap()).toBe('/fast/.funny-worktrees/repo-1/wt');
    expect(mocks.emitToUser).toHaveBeenCalledTimes(6);

    const steps = mocks.spans.filter((s) => s.name === 'worktree.setup.step');
    expect(steps.map((s) => [s.attributes.step, s.attributes.status, s.status])).toEqual([
      ['worktree:create', 'completed', 'ok'],
      ['cmd:bun install', 'completed', 'ok'],
      ['cmd:false', 'failed', 'error'],
    ]);
    expect(steps[2].error).toBe('exit 1');

    const root = mocks.spans.find((s) => s.name === 'worktree.prepare')!;
    expect(root.status).toBe('ok');
    expect(root.attributes).toMatchObject({
      flow: 'create',
      outcome: 'ok',
      'worktree.root_configured': true,
      'post_create.errors': 1,
    });
    // An array path: bun reads a dotted string as a nested path, never as one key.
    expect(root.attributes).toHaveProperty(['create.ms']);
    expect(root.attributes).toHaveProperty(['post_create.ms']);
    // Phases and steps hang off the root span.
    const children = mocks.spans.filter((s) => s.name !== 'worktree.prepare');
    expect(children.every((s) => s.parentSpanId === 's1')).toBe(true);
    expect(mocks.spans.map((s) => s.name)).toContain('worktree.create');
    expect(mocks.spans.map((s) => s.name)).toContain('worktree.post_create');

    expect(mocks.histograms.map((h) => h.name)).toEqual([
      'worktree.setup.step.duration',
      'worktree.setup.step.duration',
      'worktree.setup.step.duration',
      'worktree.prepare.duration',
    ]);
  });

  test('a failed checkout returns the error and skips the setup', async () => {
    mocks.createWorktree.mockResolvedValue(err(new Error('disk full')));

    const result = await prepareWorktree(params);

    expect(result.isErr()).toBe(true);
    expect(mocks.setupWorktree).not.toHaveBeenCalled();
    const root = mocks.spans.find((s) => s.name === 'worktree.prepare')!;
    expect(root.attributes.outcome).toBe('create_failed');
    expect(root.status).toBe('error');
  });

  test('a throw mid-step closes the open step span and propagates', async () => {
    mocks.createWorktree.mockResolvedValue(ok('/wt'));
    mocks.setupWorktree.mockImplementation(async (...args: unknown[]) => {
      (args[2] as Progress)('cmd:bun install', 'bun install', 'running');
      throw new Error('unexpected');
    });

    await expect(prepareWorktree(params)).rejects.toThrow('unexpected');

    const step = mocks.spans.find((s) => s.name === 'worktree.setup.step')!;
    expect(step.attributes.status).toBe('unfinished');
    const root = mocks.spans.find((s) => s.name === 'worktree.prepare')!;
    expect(root.attributes.outcome).toBe('error');
  });
});
