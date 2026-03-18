import { runPipeline, nullReporter } from '@funny/pipelines';
/**
 * Code Review Pipeline unit tests.
 *
 * Tests the code-review pipeline in isolation: review → fix loop,
 * verdict parsing, and corrector agent flow.
 */
import { describe, test, expect, vi } from 'vitest';

import {
  codeReviewPipeline,
  parseReviewOutput,
  type CodeReviewPipelineContext,
} from '../../pipelines/code-review.pipeline.js';
import type { ActionProvider, ActionResult } from '../../pipelines/types.js';

// ── Helpers ──────────────────────────────────────────────────

function mockProvider(overrides: Partial<ActionProvider> = {}): ActionProvider {
  return {
    spawnAgent: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    runCommand: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    gitCommit: vi.fn().mockResolvedValue({ ok: true, output: 'committed' }),
    gitPush: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    createPr: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    notify: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

function makeReviewResponse(verdict: 'pass' | 'fail', findings: any[] = []): ActionResult {
  return {
    ok: true,
    output: `Analysis complete.\n\`\`\`json\n${JSON.stringify({ verdict, findings })}\n\`\`\``,
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

function baseContext(
  provider: ActionProvider,
  overrides: Partial<CodeReviewPipelineContext> = {},
): CodeReviewPipelineContext {
  return {
    provider,
    progress: nullReporter,
    cwd: '/repo',
    commitSha: 'abc123',
    reviewer: mockReviewer,
    corrector: mockCorrector,
    iteration: 1,
    noChanges: false,
    ...overrides,
  };
}

// ── parseReviewOutput tests ────────────────────────────────

describe('parseReviewOutput', () => {
  test('parses fenced JSON block with pass verdict', () => {
    const output = 'Looks good!\n```json\n{"verdict": "pass", "findings": []}\n```';
    const result = parseReviewOutput(output);
    expect(result.verdict).toBe('pass');
    expect(result.findings).toBe('[]');
  });

  test('parses fenced JSON block with fail verdict and findings', () => {
    const findings = [{ severity: 'high', description: 'Missing null check', file: 'foo.ts' }];
    const output = `Review:\n\`\`\`json\n${JSON.stringify({ verdict: 'fail', findings })}\n\`\`\``;
    const result = parseReviewOutput(output);
    expect(result.verdict).toBe('fail');
    expect(JSON.parse(result.findings)).toEqual(findings);
  });

  test('parses raw JSON with verdict field', () => {
    const output = 'Here are my findings: {"verdict": "fail", "findings": [{"issue": "bug"}]}';
    const result = parseReviewOutput(output);
    expect(result.verdict).toBe('fail');
  });

  test('uses heuristic for "verdict": "pass" text', () => {
    const output = 'Everything is fine. "verdict": "pass" is my conclusion.';
    const result = parseReviewOutput(output);
    expect(result.verdict).toBe('pass');
  });

  test('uses heuristic for "all checks pass"', () => {
    const output = 'All checks pass. No issues found.';
    const result = parseReviewOutput(output);
    expect(result.verdict).toBe('pass');
  });

  test('defaults to fail with raw output when unparseable', () => {
    const output = 'Something went wrong, I found problems.';
    const result = parseReviewOutput(output);
    expect(result.verdict).toBe('fail');
    expect(result.findings).toBe(output);
  });

  test('handles malformed JSON in fenced block gracefully', () => {
    const output = '```json\n{invalid json}\n```';
    const result = parseReviewOutput(output);
    // Falls through to heuristic or default fail
    expect(result.verdict).toBe('fail');
  });
});

// ── Pipeline tests ──────────────────────────────────────────

describe('Code Review Pipeline', () => {
  describe('happy path — review passes', () => {
    test('completes when reviewer gives pass verdict', async () => {
      const provider = mockProvider({
        spawnAgent: vi.fn().mockResolvedValue(makeReviewResponse('pass')),
      });

      const result = await runPipeline(codeReviewPipeline, baseContext(provider));

      expect(result.outcome).toBe('completed');
      expect(result.ctx.verdict).toBe('pass');
      expect(provider.spawnAgent).toHaveBeenCalledOnce(); // only reviewer
      expect(provider.gitCommit).not.toHaveBeenCalled(); // no fix needed
    });

    test('reviewer passes agent definition to spawnAgent', async () => {
      const provider = mockProvider({
        spawnAgent: vi.fn().mockResolvedValue(makeReviewResponse('pass')),
      });

      await runPipeline(codeReviewPipeline, baseContext(provider));

      expect(provider.spawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({ agent: mockReviewer }),
      );
    });

    test('uses commit SHA in reviewer prompt', async () => {
      const provider = mockProvider({
        spawnAgent: vi.fn().mockResolvedValue(makeReviewResponse('pass')),
      });

      await runPipeline(codeReviewPipeline, baseContext(provider, { commitSha: 'deadbeef' }));

      const prompt = (provider.spawnAgent as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt;
      expect(prompt).toContain('deadbeef');
    });

    test('notifies with pass verdict', async () => {
      const provider = mockProvider({
        spawnAgent: vi.fn().mockResolvedValue(makeReviewResponse('pass')),
      });

      await runPipeline(codeReviewPipeline, baseContext(provider));

      expect(provider.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          message: expect.stringContaining('Review verdict: pass'),
          level: 'info',
        }),
      );
    });
  });

  describe('review → fix → review loop', () => {
    test('runs fix agent and retries review on fail verdict', async () => {
      const spawnAgent = vi
        .fn()
        // Review 1: fail
        .mockResolvedValueOnce(
          makeReviewResponse('fail', [{ severity: 'high', description: 'Null dereference' }]),
        )
        // Fix 1: corrector
        .mockResolvedValueOnce({ ok: true, output: 'Fixed null check' })
        // Review 2: pass
        .mockResolvedValueOnce(makeReviewResponse('pass'));

      const provider = mockProvider({ spawnAgent });

      const result = await runPipeline(codeReviewPipeline, baseContext(provider));

      expect(result.outcome).toBe('completed');
      expect(result.ctx.verdict).toBe('pass');
      // 2 reviews + 1 fix
      expect(spawnAgent).toHaveBeenCalledTimes(3);
    });

    test('corrector agent passes corrector definition to spawnAgent', async () => {
      const spawnAgent = vi
        .fn()
        .mockResolvedValueOnce(makeReviewResponse('fail', [{ description: 'bug' }]))
        .mockResolvedValueOnce({ ok: true, output: 'fixed' })
        .mockResolvedValueOnce(makeReviewResponse('pass'));

      const provider = mockProvider({ spawnAgent });
      await runPipeline(codeReviewPipeline, baseContext(provider));

      // Second call is the corrector
      expect(spawnAgent.mock.calls[1][0].agent).toEqual(mockCorrector);
    });

    test('fix commits with noVerify flag', async () => {
      const spawnAgent = vi
        .fn()
        .mockResolvedValueOnce(makeReviewResponse('fail', [{ description: 'issue' }]))
        .mockResolvedValueOnce({ ok: true, output: 'fixed' })
        .mockResolvedValueOnce(makeReviewResponse('pass'));

      const provider = mockProvider({ spawnAgent });
      await runPipeline(codeReviewPipeline, baseContext(provider));

      expect(provider.gitCommit).toHaveBeenCalledWith(
        expect.objectContaining({
          noVerify: true,
          message: expect.stringContaining('iteration 1'),
        }),
      );
    });

    test('findings are passed as context to corrector agent', async () => {
      const findings = [{ severity: 'critical', description: 'SQL injection' }];
      const spawnAgent = vi
        .fn()
        .mockResolvedValueOnce(makeReviewResponse('fail', findings))
        .mockResolvedValueOnce({ ok: true, output: 'fixed' })
        .mockResolvedValueOnce(makeReviewResponse('pass'));

      const provider = mockProvider({ spawnAgent });
      await runPipeline(codeReviewPipeline, baseContext(provider));

      // The corrector (2nd call) should have findings in prompt
      const correctorPrompt = spawnAgent.mock.calls[1][0].prompt;
      expect(correctorPrompt).toContain('SQL injection');
    });

    test('increments iteration after each fix', async () => {
      const spawnAgent = vi
        .fn()
        .mockResolvedValueOnce(makeReviewResponse('fail', [{ description: 'bug1' }]))
        .mockResolvedValueOnce({ ok: true, output: 'fixed1' })
        .mockResolvedValueOnce(makeReviewResponse('fail', [{ description: 'bug2' }]))
        .mockResolvedValueOnce({ ok: true, output: 'fixed2' })
        .mockResolvedValueOnce(makeReviewResponse('pass'));

      const provider = mockProvider({ spawnAgent });
      const result = await runPipeline(codeReviewPipeline, baseContext(provider));

      expect(result.outcome).toBe('completed');
      expect(result.ctx.iteration).toBe(3); // started at 1, incremented twice
      expect(spawnAgent).toHaveBeenCalledTimes(5); // 3 reviews + 2 fixes
    });

    test('stops after maxIterations', async () => {
      // Fix always succeeds but review always fails
      const provider = mockProvider({
        spawnAgent: vi.fn().mockImplementation((opts: any) => {
          if (opts.agent?.name === 'reviewer') {
            return Promise.resolve(makeReviewResponse('fail', [{ description: 'issue' }]));
          }
          return Promise.resolve({ ok: true, output: 'fixed' });
        }),
      });

      const result = await runPipeline(
        codeReviewPipeline,
        baseContext(provider, {
          maxIterations: 2,
        }),
      );

      expect(result.outcome).toBe('completed'); // loop exits, doesn't throw
      // After the fix node clears verdict and iteration exceeds max, loop exits
      expect(result.ctx.iteration).toBeGreaterThan(2);
    });

    test('uses custom reviewer and corrector agent definitions', async () => {
      const customReviewer = { ...mockReviewer, model: 'opus' as const };
      const customCorrector = { ...mockCorrector, model: 'haiku' as const };

      const spawnAgent = vi
        .fn()
        .mockResolvedValueOnce(makeReviewResponse('fail', [{ description: 'bug' }]))
        .mockResolvedValueOnce({ ok: true, output: 'fixed' })
        .mockResolvedValueOnce(makeReviewResponse('pass'));

      const provider = mockProvider({ spawnAgent });
      await runPipeline(
        codeReviewPipeline,
        baseContext(provider, {
          reviewer: customReviewer,
          corrector: customCorrector,
        }),
      );

      // Reviewer (1st call) uses custom definition
      expect(spawnAgent.mock.calls[0][0].agent).toEqual(customReviewer);
      // Corrector (2nd call) uses custom definition
      expect(spawnAgent.mock.calls[1][0].agent).toEqual(customCorrector);
    });

    test('uses custom reviewer systemPrompt', async () => {
      const provider = mockProvider({
        spawnAgent: vi.fn().mockResolvedValue(makeReviewResponse('pass')),
      });

      await runPipeline(
        codeReviewPipeline,
        baseContext(provider, {
          reviewer: { ...mockReviewer, systemPrompt: 'Check for security issues only' },
          commitSha: 'abc123',
        }),
      );

      const prompt = (provider.spawnAgent as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt;
      expect(prompt).toContain('Check for security issues only');
    });

    test('uses custom corrector systemPrompt', async () => {
      const spawnAgent = vi
        .fn()
        .mockResolvedValueOnce(makeReviewResponse('fail', [{ description: 'bug' }]))
        .mockResolvedValueOnce({ ok: true, output: 'fixed' })
        .mockResolvedValueOnce(makeReviewResponse('pass'));

      const provider = mockProvider({ spawnAgent });
      await runPipeline(
        codeReviewPipeline,
        baseContext(provider, {
          corrector: { ...mockCorrector, systemPrompt: 'Use the project style guide to fix' },
        }),
      );

      const prompt = spawnAgent.mock.calls[1][0].prompt;
      expect(prompt).toContain('Use the project style guide to fix');
    });
  });

  describe('failure cases', () => {
    test('fails when reviewer agent itself fails', async () => {
      const provider = mockProvider({
        spawnAgent: vi.fn().mockResolvedValue({ ok: false, error: 'Agent timeout' }),
      });

      const result = await runPipeline(codeReviewPipeline, baseContext(provider));

      expect(result.outcome).toBe('failed');
      expect(result.error).toContain('Reviewer agent failed');
      expect(result.error).toContain('Agent timeout');
    });

    test('fails when corrector agent fails', async () => {
      const spawnAgent = vi
        .fn()
        .mockResolvedValueOnce(makeReviewResponse('fail', [{ description: 'bug' }]))
        .mockResolvedValueOnce({ ok: false, error: 'Corrector crashed' });

      const provider = mockProvider({ spawnAgent });
      const result = await runPipeline(codeReviewPipeline, baseContext(provider));

      expect(result.outcome).toBe('failed');
      expect(result.error).toContain('Corrector agent failed');
    });

    test('fails when fix commit fails', async () => {
      const spawnAgent = vi
        .fn()
        .mockResolvedValueOnce(makeReviewResponse('fail', [{ description: 'bug' }]))
        .mockResolvedValueOnce({ ok: true, output: 'fixed' });

      const provider = mockProvider({
        spawnAgent,
        gitCommit: vi.fn().mockResolvedValue({ ok: false, error: 'nothing to commit' }),
      });

      const result = await runPipeline(codeReviewPipeline, baseContext(provider));

      expect(result.outcome).toBe('failed');
      expect(result.error).toContain('Fix commit failed');
    });

    test('defaults maxIterations to 10', async () => {
      // After 10 iterations (iterations 1..10), the loop stops at iteration 11
      // This test verifies the default is enforced
      const provider = mockProvider({
        spawnAgent: vi.fn().mockImplementation((opts: any) => {
          if (opts.agent?.name === 'reviewer') {
            return Promise.resolve(makeReviewResponse('fail', [{ description: 'issue' }]));
          }
          return Promise.resolve({ ok: true, output: 'fixed' });
        }),
      });

      const result = await runPipeline(codeReviewPipeline, baseContext(provider));

      // Should eventually exit the loop
      expect(result.outcome).toBe('completed');
      // iteration should be > maxIterations (11 > 10), verifying default of 10
      expect(result.ctx.iteration).toBeGreaterThan(10);
    });
  });

  describe('progress and notifications', () => {
    test('reports step progress for review and fix', async () => {
      const onStepProgress = vi.fn();
      const onPipelineEvent = vi.fn();
      const progress = { onStepProgress, onPipelineEvent };

      const spawnAgent = vi
        .fn()
        .mockResolvedValueOnce(makeReviewResponse('fail', [{ description: 'bug' }]))
        .mockResolvedValueOnce({ ok: true, output: 'fixed' })
        .mockResolvedValueOnce(makeReviewResponse('pass'));

      const provider = mockProvider({ spawnAgent });
      await runPipeline(codeReviewPipeline, baseContext(provider, { progress }));

      // Review step progress
      const reviewCalls = onStepProgress.mock.calls.filter((c: any[]) => c[0] === 'review');
      expect(reviewCalls.length).toBeGreaterThanOrEqual(2); // at least 2 reviews

      // Fix step progress
      const fixCalls = onStepProgress.mock.calls.filter((c: any[]) => c[0] === 'fix');
      expect(fixCalls.length).toBe(2); // running + completed

      // Pipeline events
      expect(onPipelineEvent).toHaveBeenCalledWith(
        'review',
        expect.objectContaining({
          iteration: 1,
          verdict: 'fail',
        }),
      );
      expect(onPipelineEvent).toHaveBeenCalledWith(
        'fix',
        expect.objectContaining({
          iteration: 1,
          hasChanges: true,
        }),
      );
    });

    test('notifies warning on fail verdict, info on pass', async () => {
      const spawnAgent = vi
        .fn()
        .mockResolvedValueOnce(makeReviewResponse('fail', [{ description: 'bug' }]))
        .mockResolvedValueOnce({ ok: true, output: 'fixed' })
        .mockResolvedValueOnce(makeReviewResponse('pass'));

      const provider = mockProvider({ spawnAgent });
      await runPipeline(codeReviewPipeline, baseContext(provider));

      const notifyCalls = (provider.notify as ReturnType<typeof vi.fn>).mock.calls;
      // First review notification: warning (fail)
      expect(notifyCalls[0][0].level).toBe('warning');
      // Second review notification: info (pass)
      const passNotify = notifyCalls.find((c: any[]) => c[0].level === 'info');
      expect(passNotify).toBeTruthy();
    });
  });
});
