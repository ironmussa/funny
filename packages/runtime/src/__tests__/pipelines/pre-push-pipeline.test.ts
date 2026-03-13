import { runPipeline, nullReporter } from '@funny/pipelines';
/**
 * Pre-Push Pipeline unit tests.
 *
 * Tests the pre-push pipeline in isolation: run tests → fix failures → retry,
 * push after tests pass.
 */
import { describe, test, expect, vi } from 'vitest';

import { prePushPipeline, type PrePushPipelineContext } from '../../pipelines/pre-push.pipeline.js';
import type { ActionProvider } from '../../pipelines/types.js';

// ── Helpers ──────────────────────────────────────────────────

function mockProvider(overrides: Partial<ActionProvider> = {}): ActionProvider {
  return {
    spawnAgent: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    runCommand: vi.fn().mockResolvedValue({ ok: true, output: 'All tests passed' }),
    gitCommit: vi.fn().mockResolvedValue({ ok: true, output: 'committed' }),
    gitPush: vi.fn().mockResolvedValue({ ok: true, output: 'pushed' }),
    createPr: vi.fn().mockResolvedValue({ ok: true, output: '' }),
    notify: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
}

function baseContext(
  provider: ActionProvider,
  overrides: Partial<PrePushPipelineContext> = {},
): PrePushPipelineContext {
  return {
    provider,
    progress: nullReporter,
    cwd: '/repo',
    testCommand: 'bun test',
    testPassed: false,
    attempt: 1,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────

describe('Pre-Push Pipeline', () => {
  describe('happy path — tests pass on first try', () => {
    test('completes successfully when tests pass', async () => {
      const provider = mockProvider();

      const result = await runPipeline(prePushPipeline, baseContext(provider));

      expect(result.outcome).toBe('completed');
      expect(result.ctx.testPassed).toBe(true);
      expect(provider.runCommand).toHaveBeenCalledOnce();
      expect(provider.spawnAgent).not.toHaveBeenCalled();
    });

    test('runs the correct test command', async () => {
      const provider = mockProvider();
      await runPipeline(
        prePushPipeline,
        baseContext(provider, {
          testCommand: 'npm run test:ci',
        }),
      );

      expect(provider.runCommand).toHaveBeenCalledWith({
        command: 'npm run test:ci',
        cwd: '/repo',
      });
    });
  });

  describe('test failure → fix → retry loop', () => {
    test('spawns fixer agent and retries tests on failure', async () => {
      let runCount = 0;
      const provider = mockProvider({
        runCommand: vi.fn().mockImplementation(() => {
          runCount++;
          if (runCount === 1) {
            return Promise.resolve({ ok: false, error: 'FAIL: 3 tests failed', output: '' });
          }
          return Promise.resolve({ ok: true, output: 'All tests passed' });
        }),
      });

      const result = await runPipeline(prePushPipeline, baseContext(provider));

      expect(result.outcome).toBe('completed');
      expect(result.ctx.testPassed).toBe(true);
      expect(provider.runCommand).toHaveBeenCalledTimes(2);
      expect(provider.spawnAgent).toHaveBeenCalledOnce(); // fixer
    });

    test('fixer agent receives test output as context', async () => {
      let runCount = 0;
      const provider = mockProvider({
        runCommand: vi.fn().mockImplementation(() => {
          runCount++;
          if (runCount === 1) {
            return Promise.resolve({
              ok: false,
              error: 'TypeError: Cannot read property "foo" of undefined',
              output: '',
            });
          }
          return Promise.resolve({ ok: true, output: 'passed' });
        }),
      });

      await runPipeline(prePushPipeline, baseContext(provider));

      expect(provider.spawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          cwd: '/repo',
          mode: 'autoEdit',
          context: 'TypeError: Cannot read property "foo" of undefined',
        }),
      );
    });

    test('fixer prompt includes test command and test output', async () => {
      let runCount = 0;
      const provider = mockProvider({
        runCommand: vi.fn().mockImplementation(() => {
          runCount++;
          if (runCount === 1) {
            return Promise.resolve({ ok: false, error: 'test failure output' });
          }
          return Promise.resolve({ ok: true, output: 'passed' });
        }),
      });

      await runPipeline(
        prePushPipeline,
        baseContext(provider, {
          testCommand: 'vitest run',
        }),
      );

      const prompt = (provider.spawnAgent as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt;
      expect(prompt).toContain('vitest run');
      expect(prompt).toContain('test failure output');
    });

    test('uses custom fixerPrompt when provided', async () => {
      let runCount = 0;
      const provider = mockProvider({
        runCommand: vi.fn().mockImplementation(() => {
          runCount++;
          if (runCount === 1) return Promise.resolve({ ok: false, error: 'error' });
          return Promise.resolve({ ok: true, output: 'ok' });
        }),
      });

      await runPipeline(
        prePushPipeline,
        baseContext(provider, {
          fixerPrompt: 'Only fix the source code, not the tests',
        }),
      );

      const prompt = (provider.spawnAgent as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt;
      expect(prompt).toContain('Only fix the source code, not the tests');
    });

    test('uses custom fixerModel', async () => {
      let runCount = 0;
      const provider = mockProvider({
        runCommand: vi.fn().mockImplementation(() => {
          runCount++;
          if (runCount === 1) return Promise.resolve({ ok: false, error: 'error' });
          return Promise.resolve({ ok: true, output: 'ok' });
        }),
      });

      await runPipeline(
        prePushPipeline,
        baseContext(provider, {
          fixerModel: 'opus',
        }),
      );

      expect(provider.spawnAgent).toHaveBeenCalledWith(expect.objectContaining({ model: 'opus' }));
    });

    test('fix commits with noVerify and descriptive message', async () => {
      let runCount = 0;
      const provider = mockProvider({
        runCommand: vi.fn().mockImplementation(() => {
          runCount++;
          if (runCount === 1) return Promise.resolve({ ok: false, error: 'error' });
          return Promise.resolve({ ok: true, output: 'ok' });
        }),
      });

      await runPipeline(prePushPipeline, baseContext(provider));

      expect(provider.gitCommit).toHaveBeenCalledWith(
        expect.objectContaining({
          noVerify: true,
          message: expect.stringContaining('test failures'),
        }),
      );
    });

    test('retries multiple times before succeeding', async () => {
      let runCount = 0;
      const provider = mockProvider({
        runCommand: vi.fn().mockImplementation(() => {
          runCount++;
          if (runCount <= 3) return Promise.resolve({ ok: false, error: `fail-${runCount}` });
          return Promise.resolve({ ok: true, output: 'passed' });
        }),
      });

      const result = await runPipeline(
        prePushPipeline,
        baseContext(provider, {
          maxRetries: 5,
        }),
      );

      expect(result.outcome).toBe('completed');
      expect(provider.runCommand).toHaveBeenCalledTimes(4); // 3 failures + 1 success
      expect(provider.spawnAgent).toHaveBeenCalledTimes(3); // 3 fix attempts
    });

    test('increments attempt counter after each fix', async () => {
      let runCount = 0;
      const provider = mockProvider({
        runCommand: vi.fn().mockImplementation(() => {
          runCount++;
          if (runCount <= 2) return Promise.resolve({ ok: false, error: 'fail' });
          return Promise.resolve({ ok: true, output: 'ok' });
        }),
      });

      const result = await runPipeline(prePushPipeline, baseContext(provider));

      // Started at 1, incremented after fix 1 and fix 2
      expect(result.ctx.attempt).toBe(3);
    });

    test('notifies on each fix attempt', async () => {
      let runCount = 0;
      const provider = mockProvider({
        runCommand: vi.fn().mockImplementation(() => {
          runCount++;
          if (runCount === 1) return Promise.resolve({ ok: false, error: 'fail' });
          return Promise.resolve({ ok: true, output: 'ok' });
        }),
      });

      await runPipeline(prePushPipeline, baseContext(provider));

      expect(provider.notify).toHaveBeenCalledWith(
        expect.objectContaining({
          level: 'warning',
          message: expect.stringContaining('Tests failed'),
        }),
      );
    });
  });

  describe('failure cases', () => {
    test('fails after max retries exceeded', async () => {
      const provider = mockProvider({
        runCommand: vi.fn().mockResolvedValue({ ok: false, error: 'persistent test failure' }),
      });

      const result = await runPipeline(
        prePushPipeline,
        baseContext(provider, {
          maxRetries: 3,
        }),
      );

      expect(result.outcome).toBe('failed');
      expect(result.error).toContain('Tests still failing after 3 attempts');
      expect(result.error).toContain('persistent test failure');
    });

    test('default maxRetries is 5', async () => {
      const provider = mockProvider({
        runCommand: vi.fn().mockResolvedValue({ ok: false, error: 'error' }),
      });

      const result = await runPipeline(prePushPipeline, baseContext(provider));

      expect(result.outcome).toBe('failed');
      expect(result.error).toContain('Tests still failing after 5 attempts');
    });

    test('fails when fixer agent fails', async () => {
      const provider = mockProvider({
        runCommand: vi.fn().mockResolvedValue({ ok: false, error: 'test fail' }),
        spawnAgent: vi.fn().mockResolvedValue({ ok: false, error: 'Agent crashed' }),
      });

      const result = await runPipeline(prePushPipeline, baseContext(provider));

      expect(result.outcome).toBe('failed');
      expect(result.error).toContain('Test fixer agent failed');
      expect(result.error).toContain('Agent crashed');
    });

    test('fails when fix commit fails', async () => {
      const provider = mockProvider({
        runCommand: vi.fn().mockResolvedValue({ ok: false, error: 'test fail' }),
        spawnAgent: vi.fn().mockResolvedValue({ ok: true, output: 'fixed' }),
        gitCommit: vi.fn().mockResolvedValue({ ok: false, error: 'nothing to commit' }),
      });

      const result = await runPipeline(prePushPipeline, baseContext(provider));

      expect(result.outcome).toBe('failed');
      expect(result.error).toContain('Fix commit failed');
    });

    test('uses error field when output is empty', async () => {
      const provider = mockProvider({
        runCommand: vi.fn().mockResolvedValue({ ok: false, error: 'the error' }),
      });

      const result = await runPipeline(
        prePushPipeline,
        baseContext(provider, {
          maxRetries: 1,
        }),
      );

      expect(result.outcome).toBe('failed');
    });

    test('falls back to output when error is empty', async () => {
      let runCount = 0;
      const provider = mockProvider({
        runCommand: vi.fn().mockImplementation(() => {
          runCount++;
          if (runCount === 1) {
            return Promise.resolve({
              ok: false,
              output: 'FAIL: test output here',
              error: undefined,
            });
          }
          return Promise.resolve({ ok: true, output: 'passed' });
        }),
      });

      await runPipeline(prePushPipeline, baseContext(provider));

      // The fixer should receive the output as context
      expect(provider.spawnAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          context: 'FAIL: test output here',
        }),
      );
    });
  });

  describe('progress reporting', () => {
    test('reports step progress for test-run and test-fix', async () => {
      const onStepProgress = vi.fn();
      const onPipelineEvent = vi.fn();
      const progress = { onStepProgress, onPipelineEvent };

      let runCount = 0;
      const provider = mockProvider({
        runCommand: vi.fn().mockImplementation(() => {
          runCount++;
          if (runCount === 1) return Promise.resolve({ ok: false, error: 'fail' });
          return Promise.resolve({ ok: true, output: 'ok' });
        }),
      });

      await runPipeline(prePushPipeline, baseContext(provider, { progress }));

      // test-run step: running + failed (1st), then running + completed (2nd)
      const testRunCalls = onStepProgress.mock.calls.filter((c: any[]) => c[0] === 'test-run');
      expect(testRunCalls.length).toBeGreaterThanOrEqual(2);

      // test-fix step: running + completed
      const fixCalls = onStepProgress.mock.calls.filter((c: any[]) => c[0] === 'test-fix');
      expect(fixCalls.length).toBe(2);

      // Pipeline events
      expect(onPipelineEvent).toHaveBeenCalledWith(
        'test_run',
        expect.objectContaining({
          attempt: 1,
          passed: false,
        }),
      );
      expect(onPipelineEvent).toHaveBeenCalledWith(
        'test_fix',
        expect.objectContaining({
          attempt: 1,
          status: 'completed',
        }),
      );
    });
  });
});
