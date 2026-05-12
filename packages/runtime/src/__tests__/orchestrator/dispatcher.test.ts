/**
 * Unit tests for OrchestratorPipelineDispatcher (from @funny/orchestrator).
 *
 * These exercise the dispatcher with a hand-crafted PipelineDefinition
 * (skipping YAML compilation, which is covered by the smoke + yaml-compiler
 * test suites). Focus is on the behaviors the orchestrator-service relies on:
 *
 *   - happy path: handle.finished resolves to { kind: 'completed' }
 *   - missing pipeline: dispatch returns { ok: false }
 *   - abort: handle.finished resolves to { kind: 'cancelled' }
 *   - pipeline failure: handle.finished resolves to { kind: 'failed', error }
 *   - lastEventAt: bumps on every step transition (stall detector input)
 *   - active map: handles are tracked and cleaned up on settle
 */

import { node, type PipelineDefinition, type ProgressReporter } from '@funny/pipelines';
import {
  OrchestratorPipelineDispatcher,
  type ContextBuilder,
  type DispatchInput,
  type DispatcherLogger,
  type PipelineLoader,
} from '@funny/thread-orchestrator';
import { describe, expect, test, vi } from 'vitest';

import type { ActionProvider } from '../../pipelines/types.js';
import type { YamlPipelineContext } from '../../pipelines/yaml-compiler.js';

// ── Helpers ──────────────────────────────────────────────────

function fakeProvider(overrides: Partial<ActionProvider> = {}): ActionProvider {
  return {
    spawnAgent: vi.fn().mockResolvedValue({ ok: true, output: 'agent-done' }),
    runCommand: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    gitCommit: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    gitPush: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    createPr: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    notify: vi.fn().mockResolvedValue({ ok: true }),
    setStatus: vi.fn().mockResolvedValue({ ok: true }),
    setStage: vi.fn().mockResolvedValue({ ok: true }),
    requestApproval: vi.fn().mockResolvedValue({ decision: 'approve' }),
    ...overrides,
  };
}

function silentLog(): DispatcherLogger {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

function makeLoader(
  pipeline: PipelineDefinition<YamlPipelineContext> | null,
): PipelineLoader<YamlPipelineContext> {
  return { load: vi.fn().mockResolvedValue(pipeline) };
}

function makeContextBuilder(provider: ActionProvider): ContextBuilder<YamlPipelineContext> {
  return {
    build: vi.fn(
      (input: DispatchInput, progress: ProgressReporter): YamlPipelineContext => ({
        provider,
        progress,
        cwd: input.cwd,
        inputs: { prompt: input.prompt, threadId: input.threadId },
        outputs: {},
      }),
    ),
  };
}

const baseInput = (over: Partial<DispatchInput> = {}): DispatchInput => ({
  threadId: 't1',
  projectId: 'p1',
  userId: 'u1',
  cwd: '/repo',
  prompt: 'go',
  ...over,
});

/** Single-node pipeline that calls provider.spawnAgent. */
function singleSpawnPipeline(): PipelineDefinition<YamlPipelineContext> {
  return {
    name: 'test-pipeline',
    nodes: [
      node<YamlPipelineContext>('dispatch', async (ctx) => {
        const result = await ctx.provider.spawnAgent({
          prompt: ctx.inputs.prompt as string,
          cwd: ctx.cwd,
        });
        if (!result.ok) throw new Error(result.error ?? 'spawn failed');
        return ctx;
      }),
    ],
  };
}

/** Two-node pipeline with a delay in node 1, used for abort tests. */
function twoStepPipeline(delayMs: number): PipelineDefinition<YamlPipelineContext> {
  return {
    name: 'test-two-step',
    nodes: [
      node<YamlPipelineContext>('first', async (ctx) => {
        await new Promise((r) => setTimeout(r, delayMs));
        return ctx;
      }),
      node<YamlPipelineContext>('second', async (ctx) => {
        await ctx.provider.spawnAgent({ prompt: 'second', cwd: ctx.cwd });
        return ctx;
      }),
    ],
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('OrchestratorPipelineDispatcher', () => {
  test('happy path: dispatch returns ok and finished resolves completed', async () => {
    const provider = fakeProvider();
    const dispatcher = new OrchestratorPipelineDispatcher<YamlPipelineContext>({
      pipelines: makeLoader(singleSpawnPipeline()),
      contextBuilder: makeContextBuilder(provider),
      log: silentLog(),
    });

    const result = await dispatcher.dispatch(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const outcome = await result.handle.finished;
    expect(outcome).toEqual({ kind: 'completed' });
    expect(provider.spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'go', cwd: '/repo' }),
    );
  });

  test('returns { ok: false } when the pipeline name does not resolve', async () => {
    const dispatcher = new OrchestratorPipelineDispatcher<YamlPipelineContext>({
      pipelines: makeLoader(null),
      contextBuilder: makeContextBuilder(fakeProvider()),
      log: silentLog(),
    });

    const result = await dispatcher.dispatch(baseInput({ pipelineName: 'missing' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/missing/);
  });

  test('handle.abort() causes finished to resolve cancelled', async () => {
    const dispatcher = new OrchestratorPipelineDispatcher<YamlPipelineContext>({
      pipelines: makeLoader(twoStepPipeline(20)),
      contextBuilder: makeContextBuilder(fakeProvider()),
      log: silentLog(),
    });

    const result = await dispatcher.dispatch(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // Abort while node "first" is sleeping. After it returns, the engine's
    // top-of-loop signal check fires before "second" executes.
    result.handle.abort();

    const outcome = await result.handle.finished;
    expect(outcome).toEqual({ kind: 'cancelled' });
  });

  test('pipeline failure surfaces as { kind: failed, error }', async () => {
    const provider = fakeProvider({
      spawnAgent: vi.fn().mockResolvedValue({ ok: false, error: 'boom' }),
    });
    const dispatcher = new OrchestratorPipelineDispatcher<YamlPipelineContext>({
      pipelines: makeLoader(singleSpawnPipeline()),
      contextBuilder: makeContextBuilder(provider),
      log: silentLog(),
    });

    const result = await dispatcher.dispatch(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const outcome = await result.handle.finished;
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.error).toMatch(/boom|spawn failed/);
  });

  test('lastEventAt advances on every step transition', async () => {
    const ticks: number[] = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    let i = 0;
    const now = () => ticks[Math.min(i++, ticks.length - 1)];

    const dispatcher = new OrchestratorPipelineDispatcher<YamlPipelineContext>({
      pipelines: makeLoader(singleSpawnPipeline()),
      contextBuilder: makeContextBuilder(fakeProvider()),
      log: silentLog(),
      now,
    });

    const result = await dispatcher.dispatch(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const initial = result.handle.lastEventAt();
    await result.handle.finished;
    const final = result.handle.lastEventAt();

    // Initial = first tick at construction. Final must be later because the
    // engine emits at least 'entering' + 'completed' state changes.
    expect(final).toBeGreaterThan(initial);
  });

  test('active map tracks runs and cleans up on settle', async () => {
    const dispatcher = new OrchestratorPipelineDispatcher<YamlPipelineContext>({
      pipelines: makeLoader(singleSpawnPipeline()),
      contextBuilder: makeContextBuilder(fakeProvider()),
      log: silentLog(),
      pipelineRunIdFactory: () => 'run-123',
    });

    const result = await dispatcher.dispatch(baseInput());
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(dispatcher.getActive('run-123')).not.toBeNull();
    expect(dispatcher.listActive()).toHaveLength(1);

    await result.handle.finished;

    expect(dispatcher.getActive('run-123')).toBeNull();
    expect(dispatcher.listActive()).toHaveLength(0);
  });
});
