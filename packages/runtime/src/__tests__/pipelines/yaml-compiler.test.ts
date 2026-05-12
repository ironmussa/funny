/**
 * YAML compiler integration tests.
 *
 * These run a YAML-defined pipeline end-to-end through the engine using
 * a mocked `ActionProvider`, validating that:
 *   - Each YAML action key dispatches to the right provider method
 *   - Mustache interpolation resolves inputs and node outputs
 *   - JSONata predicates control `when` and `until`
 *   - Loops, retries, and approvals work as documented
 */

import { parsePipelineYaml, runPipeline, nullReporter } from '@funny/pipelines';
import { describe, expect, test, vi } from 'vitest';

import type { ActionProvider } from '../../pipelines/types.js';
import { compileYamlPipeline, type YamlPipelineContext } from '../../pipelines/yaml-compiler.js';

// ── Helpers ──────────────────────────────────────────────────

function mockProvider(overrides: Partial<ActionProvider> = {}): ActionProvider {
  return {
    spawnAgent: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    runCommand: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    gitCommit: vi.fn().mockResolvedValue({ ok: true, output: 'committed' }),
    gitPush: vi.fn().mockResolvedValue({ ok: true, output: 'pushed' }),
    createPr: vi.fn().mockResolvedValue({ ok: true, output: 'https://gh/pr/1' }),
    notify: vi.fn().mockResolvedValue({ ok: true }),
    setStatus: vi.fn().mockResolvedValue({ ok: true, output: 'running' }),
    setStage: vi.fn().mockResolvedValue({ ok: true, output: 'in_progress' }),
    requestApproval: vi.fn().mockResolvedValue({ decision: 'approve' }),
    ...overrides,
  };
}

function compile(yaml: string) {
  const parsed = parsePipelineYaml(yaml);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return compileYamlPipeline(parsed.pipeline);
}

function ctxOf(
  provider: ActionProvider,
  inputs: Record<string, unknown> = {},
): YamlPipelineContext {
  return {
    provider,
    progress: nullReporter,
    cwd: '/repo',
    inputs,
    outputs: {},
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('compileYamlPipeline', () => {
  test('runs a single notify node end-to-end', async () => {
    const provider = mockProvider();
    const pipeline = compile(`
name: hello
nodes:
  - id: greet
    notify:
      message: "Hello {{name}}"
      level: info
    `);

    const result = await runPipeline(pipeline, ctxOf(provider, { name: 'Argenis' }));
    expect(result.outcome).toBe('completed');
    expect(provider.notify).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Hello Argenis', level: 'info' }),
    );
  });

  test('dispatches every action type to the provider', async () => {
    const provider = mockProvider({
      spawnAgent: vi.fn().mockResolvedValue({ ok: true, output: '{"verdict":"pass"}' }),
    });
    const pipeline = compile(`
name: full
nodes:
  - id: review
    spawn_agent:
      prompt: "Review {{branch}}"

  - id: tests
    depends_on: [review]
    run_command:
      command: "bun test"

  - id: commit
    depends_on: [tests]
    git_commit:
      message: "wip"

  - id: push
    depends_on: [commit]
    git_push:
      branch: "{{branch}}"
      set_upstream: true

  - id: pr
    depends_on: [push]
    create_pr:
      title: "wip"
      base: main

  - id: done
    depends_on: [pr]
    notify:
      message: "ok"
    `);

    const result = await runPipeline(pipeline, ctxOf(provider, { branch: 'feature/x' }));
    expect(result.outcome).toBe('completed');
    expect(provider.spawnAgent).toHaveBeenCalledOnce();
    expect(provider.runCommand).toHaveBeenCalledOnce();
    expect(provider.gitCommit).toHaveBeenCalledOnce();
    expect(provider.gitPush).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'feature/x', setUpstream: true }),
    );
    expect(provider.createPr).toHaveBeenCalledOnce();
    expect(provider.notify).toHaveBeenCalledOnce();
  });

  test('topologically sorts depends_on out of declaration order', async () => {
    const provider = mockProvider();
    // Declared as c → b → a but a is first via depends_on.
    const pipeline = compile(`
name: order
nodes:
  - id: c
    depends_on: [b]
    notify: { message: c }
  - id: b
    depends_on: [a]
    notify: { message: b }
  - id: a
    notify: { message: a }
    `);

    await runPipeline(pipeline, ctxOf(provider));

    const calls = (provider.notify as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.map((c) => c[0].message)).toEqual(['a', 'b', 'c']);
  });

  test('detects depends_on cycles at compile time', () => {
    expect(() =>
      compile(`
name: cycle
nodes:
  - id: a
    depends_on: [b]
    notify: { message: a }
  - id: b
    depends_on: [a]
    notify: { message: b }
      `),
    ).toThrow(/Cycle detected/);
  });

  test('skips nodes when JSONata predicate evaluates false', async () => {
    const provider = mockProvider();
    const pipeline = compile(`
name: skip
nodes:
  - id: gate
    when: 'flag = "yes"'
    notify: { message: 'ran' }
    `);

    await runPipeline(pipeline, ctxOf(provider, { flag: 'no' }));
    expect(provider.notify).not.toHaveBeenCalled();

    await runPipeline(pipeline, ctxOf(provider, { flag: 'yes' }));
    expect(provider.notify).toHaveBeenCalledOnce();
  });

  test('JSONata predicate sees prior node structured outputs', async () => {
    const provider = mockProvider({
      spawnAgent: vi.fn().mockResolvedValue({
        ok: true,
        output: '```json\n{"verdict":"fail"}\n```',
      }),
    });
    const pipeline = compile(`
name: dep
nodes:
  - id: review
    spawn_agent:
      prompt: review
      output_format:
        type: object
        properties:
          verdict: { type: string }

  - id: fix
    depends_on: [review]
    when: 'review.json.verdict = "fail"'
    notify: { message: 'fixing' }
    `);

    await runPipeline(pipeline, ctxOf(provider));
    expect(provider.notify).toHaveBeenCalledWith(expect.objectContaining({ message: 'fixing' }));
  });

  test('on_error: continue swallows failures and lets the pipeline finish', async () => {
    const provider = mockProvider({
      createPr: vi.fn().mockResolvedValue({ ok: false, error: 'gh: not logged in' }),
    });
    const pipeline = compile(`
name: continue
nodes:
  - id: pr
    on_error: continue
    create_pr:
      title: t

  - id: done
    depends_on: [pr]
    notify:
      message: continued
    `);

    const result = await runPipeline(pipeline, ctxOf(provider));
    expect(result.outcome).toBe('completed');
    expect(provider.notify).toHaveBeenCalledWith(expect.objectContaining({ message: 'continued' }));
  });

  test('retry config retries the underlying action', async () => {
    let attempts = 0;
    const provider = mockProvider({
      gitPush: vi.fn().mockImplementation(() => {
        attempts++;
        return Promise.resolve(
          attempts < 3 ? { ok: false, error: 'rejected' } : { ok: true, output: 'pushed' },
        );
      }),
    });
    const pipeline = compile(`
name: retry
nodes:
  - id: push
    git_push:
      branch: main
    retry:
      max_attempts: 5
    `);

    const result = await runPipeline(pipeline, ctxOf(provider));
    expect(result.outcome).toBe('completed');
    expect(attempts).toBe(3);
  });

  test('approval node pauses on requestApproval and continues on approve', async () => {
    const provider = mockProvider({
      requestApproval: vi.fn().mockResolvedValue({ decision: 'approve', comment: 'ok' }),
    });
    const pipeline = compile(`
name: gate
nodes:
  - id: confirm
    approval:
      message: "Push?"
      capture_response: true

  - id: push
    depends_on: [confirm]
    git_push:
      branch: main
    `);

    const result = await runPipeline(pipeline, ctxOf(provider));
    expect(result.outcome).toBe('completed');
    expect(provider.requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ gateId: 'confirm', captureResponse: true }),
    );
    expect(provider.gitPush).toHaveBeenCalledOnce();
  });

  test('approval rejection aborts the pipeline before the next node', async () => {
    const provider = mockProvider({
      requestApproval: vi.fn().mockResolvedValue({ decision: 'reject', reason: 'no' }),
    });
    const pipeline = compile(`
name: gate
nodes:
  - id: confirm
    approval:
      message: "Push?"

  - id: push
    depends_on: [confirm]
    git_push:
      branch: main
    `);

    const result = await runPipeline(pipeline, ctxOf(provider));
    expect(result.outcome).toBe('failed');
    expect(provider.gitPush).not.toHaveBeenCalled();
  });

  test('set_status dispatches with the seeded threadId from inputs', async () => {
    const provider = mockProvider();
    const pipeline = compile(`
name: lifecycle
nodes:
  - id: mark-running
    set_status:
      value: running
      reason: "kicking off"
    `);

    const result = await runPipeline(pipeline, ctxOf(provider, { threadId: 't-42' }));
    expect(result.outcome).toBe('completed');
    expect(provider.setStatus).toHaveBeenCalledWith({
      threadId: 't-42',
      value: 'running',
      reason: 'kicking off',
    });
  });

  test('set_stage interpolates value/reason from inputs', async () => {
    const provider = mockProvider();
    const pipeline = compile(`
name: lifecycle
nodes:
  - id: advance
    set_stage:
      value: "{{nextStage}}"
      reason: "advanced by {{actor}}"
    `);

    const result = await runPipeline(
      pipeline,
      ctxOf(provider, { threadId: 't-42', nextStage: 'review', actor: 'orchestrator' }),
    );
    expect(result.outcome).toBe('completed');
    expect(provider.setStage).toHaveBeenCalledWith({
      threadId: 't-42',
      value: 'review',
      reason: 'advanced by orchestrator',
    });
  });

  test('set_status fails the pipeline when threadId is missing from inputs', async () => {
    const provider = mockProvider();
    const pipeline = compile(`
name: lifecycle-missing-tid
nodes:
  - id: mark
    set_status:
      value: running
    `);

    const result = await runPipeline(pipeline, ctxOf(provider, {}));
    expect(result.outcome).toBe('failed');
    expect(result.error).toMatch(/threadId/);
    expect(provider.setStatus).not.toHaveBeenCalled();
  });

  test('set_stage propagates ActionProvider validation errors', async () => {
    const provider = mockProvider({
      setStage: vi.fn().mockResolvedValue({ ok: false, error: 'Invalid ThreadStage "wat"' }),
    });
    const pipeline = compile(`
name: lifecycle-invalid
nodes:
  - id: bad
    set_stage:
      value: wat
    `);

    const result = await runPipeline(pipeline, ctxOf(provider, { threadId: 't-1' }));
    expect(result.outcome).toBe('failed');
    expect(result.error).toMatch(/Invalid ThreadStage/);
  });

  test('loop with until runs the node multiple times', async () => {
    let attempts = 0;
    const provider = mockProvider({
      runCommand: vi.fn().mockImplementation(() => {
        attempts++;
        return Promise.resolve({ ok: true, output: '' });
      }),
    });
    const pipeline = compile(`
name: looper
nodes:
  - id: tick
    run_command:
      command: "echo {{attempt}}"
    loop:
      until: 'tick.output != ""'
      max_iterations: 3
    `);

    // tick.output is '' (mocked) so until is false → loop runs to max.
    const result = await runPipeline(pipeline, ctxOf(provider));
    expect(result.outcome).toBe('failed'); // hits max_iterations
    expect(attempts).toBeGreaterThanOrEqual(3);
  });
});
