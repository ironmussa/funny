import { runPipeline, nullReporter } from '@funny/pipelines';
/**
 * Commit Pipeline unit tests.
 *
 * Tests the commit pipeline in isolation: git commit with pre-commit hook
 * auto-fix and retry logic.
 */
import { describe, test, expect, vi } from 'vitest';

import { commitPipeline, type CommitPipelineContext } from '../../pipelines/commit.pipeline.js';
import type { ActionProvider } from '../../pipelines/types.js';

// ── Helpers ──────────────────────────────────────────────────

function mockProvider(overrides: Partial<ActionProvider> = {}): ActionProvider {
  return {
    spawnAgent: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    runCommand: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    gitCommit: vi
      .fn()
      .mockResolvedValue({ ok: true, output: 'committed', metadata: { sha: 'abc123' } }),
    gitPush: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    createPr: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    notify: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

function baseContext(
  provider: ActionProvider,
  overrides: Partial<CommitPipelineContext> = {},
): CommitPipelineContext {
  return {
    provider,
    progress: nullReporter,
    cwd: '/repo',
    commitMessage: 'feat: add feature',
    attempt: 1,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('Commit Pipeline', () => {
  describe('happy path', () => {
    test('commits successfully on first attempt', async () => {
      const provider = mockProvider();
      const result = await runPipeline(commitPipeline, baseContext(provider));

      expect(result.outcome).toBe('completed');
      expect(result.ctx.commitSucceeded).toBe(true);
      expect(result.ctx.commitSha).toBe('abc123');
      expect(provider.gitCommit).toHaveBeenCalledOnce();
      expect(provider.spawnAgent).not.toHaveBeenCalled();
    });

    test('passes commit message and cwd to gitCommit', async () => {
      const provider = mockProvider();
      await runPipeline(commitPipeline, baseContext(provider));

      expect(provider.gitCommit).toHaveBeenCalledWith({
        cwd: '/repo',
        message: 'feat: add feature',
        amend: undefined,
        noVerify: undefined,
      });
    });

    test('passes amend and noVerify flags', async () => {
      const provider = mockProvider();
      await runPipeline(
        commitPipeline,
        baseContext(provider, {
          amend: true,
          noVerify: true,
        }),
      );

      expect(provider.gitCommit).toHaveBeenCalledWith(
        expect.objectContaining({ amend: true, noVerify: true }),
      );
    });
  });

  describe('pre-commit hook failure and retry', () => {
    test('retries commit after spawning fixer agent', async () => {
      let callCount = 0;
      const provider = mockProvider({
        gitCommit: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve({ ok: false, error: 'eslint: 3 errors' });
          return Promise.resolve({ ok: true, output: 'committed', metadata: { sha: 'def456' } });
        }),
      });

      const result = await runPipeline(commitPipeline, baseContext(provider));

      expect(result.outcome).toBe('completed');
      expect(result.ctx.commitSucceeded).toBe(true);
      expect(result.ctx.commitSha).toBe('def456');
      expect(provider.gitCommit).toHaveBeenCalledTimes(2);
      expect(provider.spawnAgent).toHaveBeenCalledOnce();
    });

    test('fixer agent receives pre-commit error as context', async () => {
      let callCount = 0;
      const provider = mockProvider({
        gitCommit: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1)
            return Promise.resolve({ ok: false, error: 'eslint failed: no-unused-vars' });
          return Promise.resolve({ ok: true });
        }),
      });

      await runPipeline(commitPipeline, baseContext(provider));

      expect(provider.spawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/repo',
          mode: 'autoEdit',
          context: 'eslint failed: no-unused-vars',
        }),
      );
      // Prompt should include the error
      const prompt = (provider.spawnAgent as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt;
      expect(prompt).toContain('eslint failed: no-unused-vars');
    });

    test('uses custom fixerPrompt when provided', async () => {
      let callCount = 0;
      const provider = mockProvider({
        gitCommit: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve({ ok: false, error: 'hook error' });
          return Promise.resolve({ ok: true });
        }),
      });

      await runPipeline(
        commitPipeline,
        baseContext(provider, {
          fixerPrompt: 'Use prettier to fix formatting',
        }),
      );

      const prompt = (provider.spawnAgent as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt;
      expect(prompt).toContain('Use prettier to fix formatting');
      expect(prompt).toContain('hook error');
    });

    test('uses custom fixerModel when provided', async () => {
      let callCount = 0;
      const provider = mockProvider({
        gitCommit: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve({ ok: false, error: 'error' });
          return Promise.resolve({ ok: true });
        }),
      });

      await runPipeline(
        commitPipeline,
        baseContext(provider, {
          fixerModel: 'haiku',
        }),
      );

      expect(provider.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ model: 'haiku' }));
    });

    test('retries multiple times before succeeding', async () => {
      let callCount = 0;
      const provider = mockProvider({
        gitCommit: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount <= 2) return Promise.resolve({ ok: false, error: `error-${callCount}` });
          return Promise.resolve({ ok: true });
        }),
      });

      const result = await runPipeline(
        commitPipeline,
        baseContext(provider, {
          maxRetries: 5,
        }),
      );

      expect(result.outcome).toBe('completed');
      expect(provider.gitCommit).toHaveBeenCalledTimes(3);
      expect(provider.spawnAgent).toHaveBeenCalledTimes(2); // 2 fix attempts
    });

    test('notifies on each fix attempt', async () => {
      let callCount = 0;
      const provider = mockProvider({
        gitCommit: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve({ ok: false, error: 'error' });
          return Promise.resolve({ ok: true });
        }),
      });

      await runPipeline(commitPipeline, baseContext(provider));

      expect(provider.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warning',
        }),
      );
      const msg = (provider.notify as ReturnType<typeof vi.fn>).mock.calls[0][0].message;
      expect(msg).toContain('Pre-commit hook failed');
    });
  });

  describe('failure cases', () => {
    test('fails after max retries exceeded', async () => {
      const provider = mockProvider({
        gitCommit: vi.fn().mockResolvedValue({ ok: false, error: 'persistent lint error' }),
      });

      const result = await runPipeline(
        commitPipeline,
        baseContext(provider, {
          maxRetries: 2,
        }),
      );

      expect(result.outcome).toBe('failed');
      expect(result.error).toContain('Commit failed after 2 attempts');
      expect(result.error).toContain('persistent lint error');
    });

    test('fails immediately when fixer agent fails', async () => {
      const provider = mockProvider({
        gitCommit: vi.fn().mockResolvedValue({ ok: false, error: 'lint error' }),
        spawnAgent: vi.fn().mockResolvedValue({ ok: false, error: 'Agent crashed' }),
      });

      const result = await runPipeline(commitPipeline, baseContext(provider));

      expect(result.outcome).toBe('failed');
      expect(result.error).toContain('Fixer agent failed');
      expect(result.error).toContain('Agent crashed');
    });

    test('default maxRetries is 3', async () => {
      const provider = mockProvider({
        gitCommit: vi.fn().mockResolvedValue({ ok: false, error: 'error' }),
      });

      const result = await runPipeline(commitPipeline, baseContext(provider));

      expect(result.outcome).toBe('failed');
      // attempt starts at 1, retries after each fix: 1 → fix → 2 → fix → 3 → fails (attempt >= maxRetries)
      expect(result.error).toContain('Commit failed after 3 attempts');
    });

    test('clears lastHookError after successful commit', async () => {
      const provider = mockProvider();
      const result = await runPipeline(commitPipeline, baseContext(provider));

      expect(result.ctx.lastHookError).toBeUndefined();
    });
  });

  describe('progress reporting', () => {
    test('reports step progress for commit and fix stages', async () => {
      const onStepProgress = vi.fn();
      const onPipelineEvent = vi.fn();
      const progress = { onStepProgress, onPipelineEvent };

      let callCount = 0;
      const provider = mockProvider({
        gitCommit: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve({ ok: false, error: 'err' });
          return Promise.resolve({ ok: true });
        }),
      });

      await runPipeline(commitPipeline, baseContext(provider, { progress }));

      // commit step: running, then (failed internally → fix), then running again, then completed
      const commitCalls = onStepProgress.mock.calls.filter((c: any[]) => c[0] === 'commit');
      expect(commitCalls.length).toBeGreaterThanOrEqual(2);

      // fix step: running, completed
      const fixCalls = onStepProgress.mock.calls.filter((c: any[]) => c[0] === 'fix-precommit');
      expect(fixCalls.length).toBe(2); // running + completed

      // Pipeline event for precommit_fix
      expect(onPipelineEvent).toHaveBeenCalledWith(
        'precommit_fix',
        expect.objectContaining({
          attempt: 1,
          status: 'completed',
        }),
      );
    });
  });
});
