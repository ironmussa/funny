/**
 * Phase 1 smoke test for pipeline-driven dispatch.
 *
 * Proves the three behaviors the orchestrator dispatcher will rely on
 * when it swaps `POST /api/threads/:id/message` for `runPipeline()`:
 *   1. A YAML pipeline compiles and runs end-to-end against a fake
 *      ActionProvider — the API is usable outside `pipeline-manager`.
 *   2. AbortSignal cancels an in-flight `spawn_agent` action — needed so
 *      the orchestrator can interrupt a stalled run.
 *   3. ProgressReporter callbacks fire on every step transition — the
 *      dispatcher will wire these to `touchLastEvent` for stall detection.
 */

import {
  parsePipelineYaml,
  runPipeline,
  type ProgressReporter,
  type StepProgressData,
} from '@funny/pipelines';
import { describe, expect, test, vi } from 'vitest';

import type { ActionProvider } from '../../pipelines/types.js';
import { compileYamlPipeline, type YamlPipelineContext } from '../../pipelines/yaml-compiler.js';

const ORCHESTRATOR_THREAD_YAML = `
name: orchestrator-thread-smoke
inputs:
  prompt:
    type: string
    required: true
nodes:
  - id: dispatch
    spawn_agent:
      prompt: "{{prompt}}"
`;

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

function recordingReporter(): {
  reporter: ProgressReporter;
  steps: Array<{ id: string; status: StepProgressData['status'] }>;
} {
  const steps: Array<{ id: string; status: StepProgressData['status'] }> = [];
  return {
    steps,
    reporter: {
      onStepProgress: (id, data) => steps.push({ id, status: data.status }),
      onPipelineEvent: () => {},
    },
  };
}

function compile(yaml: string) {
  const parsed = parsePipelineYaml(yaml);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return compileYamlPipeline(parsed.pipeline);
}

describe('orchestrator pipeline smoke — runPipeline + YAML standalone', () => {
  test('compiles orchestrator-thread YAML and runs the spawn_agent dispatch', async () => {
    const provider = fakeProvider();
    const pipeline = compile(ORCHESTRATOR_THREAD_YAML);

    const result = await runPipeline<YamlPipelineContext>(pipeline, {
      provider,
      progress: recordingReporter().reporter,
      cwd: '/repo',
      inputs: { prompt: 'pick up the thread' },
      outputs: {},
    });

    expect(result.outcome).toBe('completed');
    expect(provider.spawnAgent).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'pick up the thread', cwd: '/repo' }),
    );
    expect(result.ctx.outputs.dispatch?.output).toBe('agent-done');
  });

  test('AbortSignal cancels mid-flight spawn_agent — orchestrator stall path', async () => {
    let aborted = false;
    const ctrl = new AbortController();

    const provider = fakeProvider({
      spawnAgent: vi.fn().mockImplementation(async () => {
        ctrl.abort();
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { ok: true, output: 'should-not-be-used' };
      }),
    });

    const pipeline = compile(`
name: orchestrator-cancel-smoke
nodes:
  - id: first
    spawn_agent:
      prompt: "step one"
  - id: second
    depends_on: [first]
    spawn_agent:
      prompt: "step two"
`);

    const result = await runPipeline<YamlPipelineContext>(
      pipeline,
      {
        provider,
        progress: { onStepProgress: () => {}, onPipelineEvent: () => {} },
        cwd: '/repo',
        inputs: {},
        outputs: {},
      },
      {
        signal: ctrl.signal,
        onStateChange: (change) => {
          if (change.kind === 'terminal') aborted = change.outcome === 'cancelled';
        },
      },
    );

    expect(result.outcome).toBe('cancelled');
    expect(aborted).toBe(true);
    expect(provider.spawnAgent).toHaveBeenCalledTimes(1);
  });

  test('ProgressReporter fires running→completed for each step (stall-detection hook)', async () => {
    const { reporter, steps } = recordingReporter();

    const pipeline = compile(`
name: orchestrator-progress-smoke
nodes:
  - id: review
    spawn_agent:
      prompt: "review the change"
  - id: tests
    depends_on: [review]
    run_command:
      command: "bun test"
`);

    const result = await runPipeline<YamlPipelineContext>(pipeline, {
      provider: fakeProvider(),
      progress: reporter,
      cwd: '/repo',
      inputs: {},
      outputs: {},
    });

    expect(result.outcome).toBe('completed');
    expect(steps).toEqual([
      { id: 'review', status: 'running' },
      { id: 'review', status: 'completed' },
      { id: 'tests', status: 'running' },
      { id: 'tests', status: 'completed' },
    ]);
  });
});
