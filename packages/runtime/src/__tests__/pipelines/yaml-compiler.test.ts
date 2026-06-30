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

import { runPipeline, nullReporter } from '@funny/pipelines';
import { parseWorkflowYaml } from '@funny/workflows';
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
  const parsed = parseWorkflowYaml(yaml);
  if (!parsed.ok) throw new Error(parsed.error.message);
  return compileYamlPipeline(parsed.workflow);
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
      ctxOf(provider, { threadId: 't-42', nextStage: 'review', actor: 'scheduler' }),
    );
    expect(result.outcome).toBe('completed');
    expect(provider.setStage).toHaveBeenCalledWith({
      threadId: 't-42',
      value: 'review',
      reason: 'advanced by scheduler',
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

  // ── Phase 3: parallel DAG execution of YAML pipelines ──────
  describe('parallel DAG (depends_on)', () => {
    test('sibling proposer nodes run concurrently and the judge merges their outputs', async () => {
      let active = 0;
      let maxActive = 0;
      // spawnAgent echoes the prompt so we can assert the judge saw both
      // proposer outputs interpolated into its prompt.
      const spawnAgent = vi.fn(async (args: { prompt: string }) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((r) => setTimeout(r, 10));
        active--;
        return { ok: true, output: `out:${args.prompt}` };
      });
      const provider = mockProvider({ spawnAgent });

      // Fusion shape: three rootless proposers + a judge depending on all.
      const pipeline = compile(`
name: fusion
inputs:
  question: { type: string, required: true }
nodes:
  - id: proposer-a
    spawn_agent: { prompt: "A:{{question}}" }
  - id: proposer-b
    spawn_agent: { prompt: "B:{{question}}" }
  - id: proposer-c
    spawn_agent: { prompt: "C:{{question}}" }
  - id: judge
    depends_on: [proposer-a, proposer-b, proposer-c]
    spawn_agent:
      prompt: "{{proposer-a.output}}|{{proposer-b.output}}|{{proposer-c.output}}"
      `);

      const result = await runPipeline(pipeline, ctxOf(provider, { question: 'q' }));

      expect(result.outcome).toBe('completed');
      // All three proposers were in flight simultaneously.
      expect(maxActive).toBe(3);
      // The judge ran last and saw all three proposer outputs merged in.
      expect(spawnAgent).toHaveBeenLastCalledWith(
        expect.objectContaining({ prompt: 'out:A:q|out:B:q|out:C:q' }),
      );
    });

    test('on_error: continue lets the judge proceed when a proposer fails (quorum)', async () => {
      const spawnAgent = vi.fn(async (args: { prompt: string }) => {
        if (args.prompt.startsWith('B:')) return { ok: false, error: 'B died' };
        return { ok: true, output: `out:${args.prompt}` };
      });
      const provider = mockProvider({ spawnAgent });

      const pipeline = compile(`
name: fusion-quorum
inputs:
  question: { type: string, required: true }
nodes:
  - id: proposer-a
    spawn_agent: { prompt: "A:{{question}}" }
  - id: proposer-b
    on_error: continue
    spawn_agent: { prompt: "B:{{question}}" }
  - id: proposer-c
    spawn_agent: { prompt: "C:{{question}}" }
  - id: judge
    depends_on: [proposer-a, proposer-b, proposer-c]
    spawn_agent:
      prompt: "{{proposer-a.output}}|{{proposer-b.output}}|{{proposer-c.output}}"
      `);

      const result = await runPipeline(pipeline, ctxOf(provider, { question: 'q' }));

      expect(result.outcome).toBe('completed');
      // B's output is empty (swallowed), A and C present.
      expect(spawnAgent).toHaveBeenLastCalledWith(
        expect.objectContaining({ prompt: 'out:A:q||out:C:q' }),
      );
    });

    test('a sibling failure without on_error fails the whole pipeline', async () => {
      const spawnAgent = vi.fn(async (args: { prompt: string }) => {
        if (args.prompt.startsWith('B:')) return { ok: false, error: 'B exploded' };
        return { ok: true, output: 'ok' };
      });
      const provider = mockProvider({ spawnAgent });

      const pipeline = compile(`
name: fusion-strict
inputs:
  question: { type: string, required: true }
nodes:
  - id: proposer-a
    spawn_agent: { prompt: "A:{{question}}" }
  - id: proposer-b
    spawn_agent: { prompt: "B:{{question}}" }
  - id: judge
    depends_on: [proposer-a, proposer-b]
    spawn_agent: { prompt: "{{proposer-a.output}}|{{proposer-b.output}}" }
      `);

      const result = await runPipeline(pipeline, ctxOf(provider, { question: 'q' }));
      expect(result.outcome).toBe('failed');
      expect(result.error).toMatch(/B exploded/);
      // judge must NOT have run (its level never started).
      const judgeCalled = (spawnAgent as ReturnType<typeof vi.fn>).mock.calls.some((c) =>
        String(c[0].prompt).includes('|'),
      );
      expect(judgeCalled).toBe(false);
    });
  });

  // ── Per-node provider forwarding (heterogeneous panels) ─────
  describe('per-node provider', () => {
    test('forwards spawn_agent.provider to the ActionProvider', async () => {
      const spawnAgent = vi.fn().mockResolvedValue({ ok: true, output: '' });
      const provider = mockProvider({ spawnAgent });

      const pipeline = compile(`
name: heterogeneous
inputs:
  q: { type: string, required: true }
nodes:
  - id: a
    spawn_agent: { provider: codex, model: gpt-5.5, prompt: "{{q}}" }
  - id: b
    depends_on: [a]
    spawn_agent: { provider: gemini, model: gemini-3-pro, prompt: "{{q}}" }
      `);

      const result = await runPipeline(pipeline, ctxOf(provider, { q: 'hi' }));
      expect(result.outcome).toBe('completed');
      expect(spawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'codex', model: 'gpt-5.5' }),
      );
      expect(spawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({ provider: 'gemini', model: 'gemini-3-pro' }),
      );
    });

    test('omitting provider leaves it undefined (adapter default applies)', async () => {
      const spawnAgent = vi.fn().mockResolvedValue({ ok: true, output: '' });
      const provider = mockProvider({ spawnAgent });

      const pipeline = compile(`
name: default-provider
nodes:
  - id: a
    spawn_agent: { prompt: "hi" }
      `);

      await runPipeline(pipeline, ctxOf(provider));
      expect(spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ provider: undefined }));
    });
  });
});
