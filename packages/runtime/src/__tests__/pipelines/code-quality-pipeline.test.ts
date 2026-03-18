import { runPipeline, nullReporter } from '@funny/pipelines';
/**
 * Code Quality Pipeline unit tests.
 *
 * Tests the code-quality pipeline definition using a fully mocked
 * ActionProvider. Validates the commit → review → fix loop → push → PR flow.
 *
 * Note: code-quality now composes sub-pipelines (commit, code-review, pre-push).
 * These tests validate the full composition. Individual pipeline tests should
 * cover edge cases for each sub-pipeline.
 */
import { describe, test, expect, vi } from 'vitest';

import {
  codeQualityPipeline,
  type CodeQualityContext,
} from '../../pipelines/code-quality.pipeline.js';
import type { ActionProvider, ActionResult } from '../../pipelines/types.js';

// ── Mock Provider Factory ───────────────────────────────────

function mockProvider(overrides: Partial<ActionProvider> = {}): ActionProvider {
  return {
    spawnAgent: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    runCommand: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    gitCommit: vi.fn().mockResolvedValue({ ok: true, output: 'committed' }),
    gitPush: vi.fn().mockResolvedValue({ ok: true, output: 'pushed' }),
    createPr: vi.fn().mockResolvedValue({ ok: true, output: 'https://github.com/pr/1' }),
    notify: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

function makeReviewResponse(verdict: 'pass' | 'fail', findings: any[] = []): ActionResult {
  return {
    ok: true,
    output: `Some analysis...\n\`\`\`json\n${JSON.stringify({ verdict, findings })}\n\`\`\``,
  };
}

const mockReviewer = {
  name: 'reviewer',
  label: 'Code Reviewer',
  systemPrompt: (ctx: Record<string, string>) =>
    `You are a code reviewer. Review commit ${ctx.commitSha || 'HEAD'}.`,
  model: 'sonnet' as const,
  provider: 'claude' as const,
  permissionMode: 'plan' as const,
};

const mockCorrector = {
  name: 'corrector',
  label: 'Code Corrector',
  systemPrompt: 'You are a code corrector. Fix the issues.',
  model: 'sonnet' as const,
  provider: 'claude' as const,
  permissionMode: 'autoEdit' as const,
};

const mockPrecommitFixer = {
  name: 'precommit-fixer',
  label: 'Pre-commit Fixer',
  systemPrompt: 'Fix pre-commit hook issues.',
  model: 'sonnet' as const,
  provider: 'claude' as const,
  permissionMode: 'autoEdit' as const,
};

const mockTestFixer = {
  name: 'test-fixer',
  label: 'Test Fixer',
  systemPrompt: 'Fix test failures in the source code.',
  model: 'sonnet' as const,
  provider: 'claude' as const,
  permissionMode: 'autoEdit' as const,
};

function baseContext(provider: ActionProvider): CodeQualityContext {
  return {
    provider,
    progress: nullReporter,
    cwd: '/repo',
    commitMessage: 'feat: add feature',
    branch: 'feature/test',
    reviewer: mockReviewer,
    corrector: mockCorrector,
    precommitFixer: mockPrecommitFixer,
    testFixer: mockTestFixer,
    maxCommitRetries: 2,
    maxReviewIterations: 3,
    maxPushRetries: 2,
  };
}

// ── Tests ───────────────────────────────────────────────────

describe('Code Quality Pipeline', () => {
  describe('happy path — commit, review pass, push, PR', () => {
    test('completes successfully when review passes on first try', async () => {
      const provider = mockProvider({
        spawnAgent: vi.fn().mockResolvedValue(makeReviewResponse('pass')),
      });

      const result = await runPipeline(codeQualityPipeline, baseContext(provider));

      expect(result.outcome).toBe('completed');
      expect(provider.gitCommit).toHaveBeenCalled();
      expect(provider.spawnAgent).toHaveBeenCalled(); // reviewer
      expect(provider.gitPush).toHaveBeenCalledOnce();
      expect(provider.createPr).toHaveBeenCalledOnce();
    });

    test('context contains PR URL after completion', async () => {
      const provider = mockProvider({
        spawnAgent: vi.fn().mockResolvedValue(makeReviewResponse('pass')),
        createPr: vi
          .fn()
          .mockResolvedValue({ ok: true, output: 'https://github.com/repo/pull/42' }),
      });

      const result = await runPipeline(codeQualityPipeline, baseContext(provider));

      expect(result.ctx.prUrl).toBe('https://github.com/repo/pull/42');
    });
  });

  describe('commit step — pre-commit hook failure and retry', () => {
    test('retries commit after spawning fixer agent on pre-commit failure', async () => {
      let commitCall = 0;
      const provider = mockProvider({
        gitCommit: vi.fn().mockImplementation(() => {
          commitCall++;
          if (commitCall === 1) {
            return Promise.resolve({ ok: false, error: 'eslint: 3 errors found' });
          }
          return Promise.resolve({ ok: true, output: 'committed' });
        }),
        spawnAgent: vi
          .fn()
          // First call: fixer for pre-commit
          .mockResolvedValueOnce({ ok: true, output: 'Fixed lint errors' })
          // Second call: reviewer
          .mockResolvedValueOnce(makeReviewResponse('pass')),
      });

      const result = await runPipeline(codeQualityPipeline, baseContext(provider));

      expect(result.outcome).toBe('completed');
      expect(provider.gitCommit).toHaveBeenCalledTimes(2);
      // First spawnAgent = pre-commit fixer, second = reviewer
      expect(provider.spawnAgent).toHaveBeenCalledTimes(2);
    });

    test('fails after max commit retries', async () => {
      const provider = mockProvider({
        gitCommit: vi.fn().mockResolvedValue({ ok: false, error: 'lint error' }),
        spawnAgent: vi.fn().mockResolvedValue({ ok: true, output: 'tried to fix' }),
      });

      const ctx = baseContext(provider);
      ctx.maxCommitRetries = 2;

      const result = await runPipeline(codeQualityPipeline, ctx);

      expect(result.outcome).toBe('failed');
      expect(result.error).toContain('Commit failed after 2 attempts');
    });

    test('fails immediately when fixer agent fails', async () => {
      const provider = mockProvider({
        gitCommit: vi.fn().mockResolvedValue({ ok: false, error: 'lint error' }),
        spawnAgent: vi.fn().mockResolvedValue({ ok: false, error: 'Agent crashed' }),
      });

      const result = await runPipeline(codeQualityPipeline, baseContext(provider));

      expect(result.outcome).toBe('failed');
      expect(result.error).toContain('Fixer agent failed');
    });
  });

  describe('review step — verdict parsing', () => {
    test('parses JSON verdict pass correctly', async () => {
      const provider = mockProvider({
        spawnAgent: vi.fn().mockResolvedValue(makeReviewResponse('pass')),
      });

      const result = await runPipeline(codeQualityPipeline, baseContext(provider));

      expect(result.outcome).toBe('completed');
      // The review verdict is on the context (propagated back from sub-pipeline)
      expect(result.ctx.reviewVerdict).toBe('pass');
    });

    test('parses JSON verdict fail and triggers fix loop', async () => {
      const spawnAgent = vi
        .fn()
        // Iteration 1: review fail
        .mockResolvedValueOnce(
          makeReviewResponse('fail', [{ severity: 'high', description: 'Missing null check' }]),
        )
        // Iteration 1: fix
        .mockResolvedValueOnce({ ok: true, output: 'Fixed null check' })
        // Iteration 2: review pass
        .mockResolvedValueOnce(makeReviewResponse('pass'));

      const provider = mockProvider({ spawnAgent });

      const result = await runPipeline(codeQualityPipeline, baseContext(provider));

      expect(result.outcome).toBe('completed');
    });

    test('falls back to heuristic when no JSON block found', async () => {
      const provider = mockProvider({
        spawnAgent: vi.fn().mockResolvedValue({
          ok: true,
          output: 'Everything looks good. "verdict": "pass"',
        }),
      });

      const result = await runPipeline(codeQualityPipeline, baseContext(provider));

      expect(result.outcome).toBe('completed');
    });

    test('fails when reviewer agent itself fails', async () => {
      const provider = mockProvider({
        spawnAgent: vi.fn().mockResolvedValue({ ok: false, error: 'Agent timeout' }),
      });

      const result = await runPipeline(codeQualityPipeline, baseContext(provider));

      expect(result.outcome).toBe('failed');
      expect(result.error).toContain('Reviewer agent failed');
    });
  });

  describe('push step', () => {
    test('pushes with setUpstream and branch', async () => {
      const provider = mockProvider({
        spawnAgent: vi.fn().mockResolvedValue(makeReviewResponse('pass')),
      });

      await runPipeline(codeQualityPipeline, baseContext(provider));

      expect(provider.gitPush).toHaveBeenCalledWith({
        cwd: '/repo',
        branch: 'feature/test',
        setUpstream: true,
      });
    });

    test('retries push after spawning fixer on failure', async () => {
      let pushCall = 0;
      const spawnAgent = vi
        .fn()
        // reviewer
        .mockResolvedValueOnce(makeReviewResponse('pass'))
        // push fixer
        .mockResolvedValueOnce({ ok: true, output: 'resolved merge conflicts' });

      const gitPush = vi.fn().mockImplementation(() => {
        pushCall++;
        if (pushCall === 1) {
          return Promise.resolve({ ok: false, error: 'rejected: non-fast-forward' });
        }
        return Promise.resolve({ ok: true, output: 'pushed' });
      });

      const provider = mockProvider({ spawnAgent, gitPush });

      const result = await runPipeline(codeQualityPipeline, baseContext(provider));

      expect(result.outcome).toBe('completed');
      expect(gitPush).toHaveBeenCalledTimes(2);
    });

    test('fails after max push retries', async () => {
      const spawnAgent = vi
        .fn()
        .mockResolvedValueOnce(makeReviewResponse('pass'))
        .mockResolvedValue({ ok: true, output: 'tried' }); // fixer always succeeds

      const provider = mockProvider({
        spawnAgent,
        gitPush: vi.fn().mockResolvedValue({ ok: false, error: 'push rejected' }),
      });

      const ctx = baseContext(provider);
      ctx.maxPushRetries = 2;

      const result = await runPipeline(codeQualityPipeline, ctx);

      expect(result.outcome).toBe('failed');
      expect(result.error).toContain('Push failed after 2 attempts');
    });
  });

  describe('create-pr step', () => {
    test('PR failure is non-fatal — pipeline continues', async () => {
      const provider = mockProvider({
        spawnAgent: vi.fn().mockResolvedValue(makeReviewResponse('pass')),
        createPr: vi.fn().mockResolvedValue({ ok: false, error: 'gh: not logged in' }),
      });

      const result = await runPipeline(codeQualityPipeline, baseContext(provider));

      expect(result.outcome).toBe('completed');
      expect(result.ctx.prUrl).toBeUndefined();
    });

    test('passes base branch to createPr', async () => {
      const provider = mockProvider({
        spawnAgent: vi.fn().mockResolvedValue(makeReviewResponse('pass')),
      });

      const ctx = baseContext(provider);
      ctx.baseBranch = 'develop';

      await runPipeline(codeQualityPipeline, ctx);

      expect(provider.createPr).toHaveBeenCalledWith({
        cwd: '/repo',
        title: 'feat: add feature',
        base: 'develop',
      });
    });
  });

  describe('notification flow', () => {
    test('notifies on pre-commit hook failure', async () => {
      let commitCall = 0;
      const provider = mockProvider({
        gitCommit: vi.fn().mockImplementation(() => {
          commitCall++;
          if (commitCall === 1) return Promise.resolve({ ok: false, error: 'lint' });
          return Promise.resolve({ ok: true });
        }),
        spawnAgent: vi
          .fn()
          .mockResolvedValueOnce({ ok: true, output: 'fixed' })
          .mockResolvedValueOnce(makeReviewResponse('pass')),
      });

      await runPipeline(codeQualityPipeline, baseContext(provider));

      const notifyCalls = (provider.notify as ReturnType<typeof vi.fn>).mock.calls;
      const hookFailNotify = notifyCalls.find((c: any[]) =>
        c[0].message.includes('Pre-commit hook failed'),
      );
      expect(hookFailNotify).toBeTruthy();
      expect(hookFailNotify![0].level).toBe('warning');
    });

    test('notifies review verdict after each review', async () => {
      const provider = mockProvider({
        spawnAgent: vi.fn().mockResolvedValue(makeReviewResponse('pass')),
      });

      await runPipeline(codeQualityPipeline, baseContext(provider));

      const notifyCalls = (provider.notify as ReturnType<typeof vi.fn>).mock.calls;
      const verdictNotify = notifyCalls.find((c: any[]) =>
        c[0].message.includes('Review verdict: pass'),
      );
      expect(verdictNotify).toBeTruthy();
    });

    test('notifies pipeline completion with branch and PR info', async () => {
      const provider = mockProvider({
        spawnAgent: vi.fn().mockResolvedValue(makeReviewResponse('pass')),
        createPr: vi.fn().mockResolvedValue({ ok: true, output: 'https://github.com/pr/99' }),
      });

      await runPipeline(codeQualityPipeline, baseContext(provider));

      const notifyCalls = (provider.notify as ReturnType<typeof vi.fn>).mock.calls;
      const doneNotify = notifyCalls.find((c: any[]) => c[0].message.includes('Pipeline complete'));
      expect(doneNotify).toBeTruthy();
      expect(doneNotify![0].message).toContain('feature/test');
      expect(doneNotify![0].message).toContain('https://github.com/pr/99');
    });
  });
});
