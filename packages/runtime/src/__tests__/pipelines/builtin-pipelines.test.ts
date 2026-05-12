/**
 * End-to-end tests for the built-in YAML pipelines.
 *
 * Loads the actual YAML files from `pipelines/defaults/`, compiles them,
 * and runs them with a mocked ActionProvider. This is the regression
 * suite that replaces the per-pipeline TS test files (commit-pipeline,
 * code-review-pipeline, pre-push-pipeline, code-quality-pipeline) which
 * were deleted along with the .pipeline.ts source files.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { runPipeline, nullReporter } from '@funny/pipelines';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import type { ActionProvider, ActionResult } from '../../pipelines/types.js';
import type { YamlPipelineContext } from '../../pipelines/yaml-compiler.js';
import { loadPipelines } from '../../pipelines/yaml-loader.js';
import { resolveBuiltinAgentByName } from '../../services/agent-registry.js';

// ── Helpers ──────────────────────────────────────────────────

function mockProvider(overrides: Partial<ActionProvider> = {}): ActionProvider {
  return {
    spawnAgent: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    runCommand: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    gitCommit: vi
      .fn()
      .mockResolvedValue({ ok: true, output: 'committed', metadata: { sha: 'abc123' } }),
    gitPush: vi.fn().mockResolvedValue({ ok: true, output: 'pushed' }),
    createPr: vi.fn().mockResolvedValue({ ok: true, output: 'https://gh/pr/1' }),
    notify: vi.fn().mockResolvedValue({ ok: true }),
    setStatus: vi.fn().mockResolvedValue({ ok: true }),
    setStage: vi.fn().mockResolvedValue({ ok: true }),
    requestApproval: vi.fn().mockResolvedValue({ decision: 'approve' }),
    ...overrides,
  };
}

function reviewOk(): ActionResult {
  return { ok: true, output: '```json\n{"verdict":"pass","findings":[]}\n```' };
}

function reviewFail(findings: unknown[] = [{ description: 'bug' }]): ActionResult {
  return {
    ok: true,
    output: `\`\`\`json\n${JSON.stringify({ verdict: 'fail', findings })}\n\`\`\``,
  };
}

let workDir: string;
beforeEach(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), 'funny-builtin-'));
});
afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

async function loadBuiltins() {
  const result = await loadPipelines({
    repoRoot: workDir,
    resolveAgent: resolveBuiltinAgentByName,
  });
  return result.pipelines;
}

function ctx(provider: ActionProvider, inputs: Record<string, unknown>): YamlPipelineContext {
  return {
    provider,
    progress: nullReporter,
    cwd: '/repo',
    inputs,
    outputs: {},
  };
}

// ── commit ───────────────────────────────────────────────────

describe('built-in: commit', () => {
  test('happy path — commits successfully on first try', async () => {
    const provider = mockProvider();
    const pipelines = await loadBuiltins();
    const result = await runPipeline(
      pipelines.get('commit')!.definition,
      ctx(provider, { commit_message: 'wip' }),
    );
    expect(result.outcome).toBe('completed');
    expect(provider.gitCommit).toHaveBeenCalledWith(expect.objectContaining({ message: 'wip' }));
    expect(provider.spawnAgent).not.toHaveBeenCalled();
  });

  test('spawns precommit-fixer + retries when hook fails', async () => {
    let attempt = 0;
    const provider = mockProvider({
      gitCommit: vi.fn().mockImplementation(() => {
        attempt++;
        return Promise.resolve(
          attempt < 2
            ? { ok: false, error: 'pre-commit hook failed: lint errors' }
            : { ok: true, output: 'committed', metadata: { sha: 'abc' } },
        );
      }),
    });
    const pipelines = await loadBuiltins();
    const result = await runPipeline(
      pipelines.get('commit')!.definition,
      ctx(provider, { commit_message: 'wip' }),
    );
    expect(result.outcome).toBe('completed');
    expect(provider.spawnAgent).toHaveBeenCalledOnce();
    // The fixer prompt sees LAST_ERROR.
    const prompt = (provider.spawnAgent as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt;
    expect(prompt).toContain('lint errors');
  });
});

// ── code-review ──────────────────────────────────────────────

describe('built-in: code-review', () => {
  test('exits the loop on pass verdict', async () => {
    const provider = mockProvider({
      spawnAgent: vi.fn().mockResolvedValue(reviewOk()),
    });
    const pipelines = await loadBuiltins();
    const result = await runPipeline(
      pipelines.get('code-review')!.definition,
      ctx(provider, { commit_sha: 'HEAD' }),
    );
    expect(result.outcome).toBe('completed');
    expect(provider.spawnAgent).toHaveBeenCalledOnce(); // reviewer only
  });

  test('runs review → fix → commit-fix → review loop until pass', async () => {
    const sa = vi
      .fn()
      .mockResolvedValueOnce(reviewFail([{ description: 'bug' }])) // review #1
      .mockResolvedValueOnce({ ok: true, output: 'fixed' }) // fix (corrector)
      .mockResolvedValueOnce(reviewOk()); // review #2

    // The pipeline-side commit captures the new SHA in metadata.sha.
    const commit = vi
      .fn()
      .mockResolvedValue({ ok: true, output: 'committed', metadata: { sha: 'fix-sha' } });

    const provider = mockProvider({ spawnAgent: sa, gitCommit: commit });
    const pipelines = await loadBuiltins();
    const result = await runPipeline(
      pipelines.get('code-review')!.definition,
      ctx(provider, { commit_sha: 'HEAD' }),
    );
    expect(result.outcome).toBe('completed');
    expect(sa).toHaveBeenCalledTimes(3); // 2 reviews + 1 fix
    expect(commit).toHaveBeenCalledOnce();
    // After the fix iteration, ctx.outputs.commit-fix.json.sha is exposed.
    expect((result.ctx.outputs as Record<string, any>)['commit-fix']?.json?.sha).toBe('fix-sha');
  });

  test('reviewer is invoked with the reviewer agent', async () => {
    const sa = vi.fn().mockResolvedValue(reviewOk());
    const provider = mockProvider({ spawnAgent: sa });
    const pipelines = await loadBuiltins();
    await runPipeline(
      pipelines.get('code-review')!.definition,
      ctx(provider, { commit_sha: 'HEAD' }),
    );
    expect(sa.mock.calls[0][0].agent).toEqual(expect.objectContaining({ name: 'reviewer' }));
  });
});

// ── pre-push ─────────────────────────────────────────────────

describe('built-in: pre-push', () => {
  test('passes when tests succeed', async () => {
    const provider = mockProvider();
    const pipelines = await loadBuiltins();
    const result = await runPipeline(
      pipelines.get('pre-push')!.definition,
      ctx(provider, { test_command: 'bun test' }),
    );
    expect(result.outcome).toBe('completed');
    expect(provider.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'bun test' }),
    );
    expect(provider.spawnAgent).not.toHaveBeenCalled();
  });

  test('spawns test-fixer + retries on failure', async () => {
    let n = 0;
    const provider = mockProvider({
      runCommand: vi.fn().mockImplementation(() => {
        n++;
        return Promise.resolve(
          n < 3 ? { ok: false, error: 'tests failed' } : { ok: true, output: 'pass' },
        );
      }),
    });
    const pipelines = await loadBuiltins();
    const result = await runPipeline(
      pipelines.get('pre-push')!.definition,
      ctx(provider, { test_command: 'bun test' }),
    );
    expect(result.outcome).toBe('completed');
    expect(provider.spawnAgent).toHaveBeenCalledTimes(2); // fixer ran twice
  });
});

// ── code-quality (composition) ───────────────────────────────

describe('built-in: code-quality', () => {
  test('runs commit → review → tests → push → PR → notify in order', async () => {
    const provider = mockProvider({
      spawnAgent: vi.fn().mockResolvedValue(reviewOk()),
    });
    const pipelines = await loadBuiltins();
    const result = await runPipeline(
      pipelines.get('code-quality')!.definition,
      ctx(provider, {
        commit_message: 'wip',
        branch: 'feature/x',
        base_branch: 'main',
        test_command: 'bun test',
        commit_sha: 'HEAD',
      }),
    );
    expect(result.outcome).toBe('completed');
    expect(provider.gitCommit).toHaveBeenCalled();
    expect(provider.spawnAgent).toHaveBeenCalled(); // reviewer
    expect(provider.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'bun test' }),
    );
    expect(provider.gitPush).toHaveBeenCalledWith(
      expect.objectContaining({ branch: 'feature/x', setUpstream: true }),
    );
    expect(provider.createPr).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'wip', base: 'main' }),
    );
    expect(provider.notify).toHaveBeenCalledOnce();
  });

  test('skips test step when test_command is unset', async () => {
    const provider = mockProvider({
      spawnAgent: vi.fn().mockResolvedValue(reviewOk()),
    });
    const pipelines = await loadBuiltins();
    await runPipeline(
      pipelines.get('code-quality')!.definition,
      ctx(provider, {
        commit_message: 'wip',
        branch: 'feature/x',
        base_branch: 'main',
        commit_sha: 'HEAD',
      }),
    );
    expect(provider.runCommand).not.toHaveBeenCalled();
  });

  test('PR creation failure is non-fatal (on_error: continue)', async () => {
    const provider = mockProvider({
      spawnAgent: vi.fn().mockResolvedValue(reviewOk()),
      createPr: vi.fn().mockResolvedValue({ ok: false, error: 'gh: not logged in' }),
    });
    const pipelines = await loadBuiltins();
    const result = await runPipeline(
      pipelines.get('code-quality')!.definition,
      ctx(provider, {
        commit_message: 'wip',
        branch: 'feature/x',
        base_branch: 'main',
        commit_sha: 'HEAD',
      }),
    );
    expect(result.outcome).toBe('completed');
    expect(provider.notify).toHaveBeenCalled(); // 'done' node still ran
  });
});
