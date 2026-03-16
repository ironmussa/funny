/**
 * Pre-Push Pipeline
 *
 * Runs tests before push and auto-fixes failures:
 *   1. Run test command
 *   2. If tests fail → spawn fixer agent → retry tests
 *   3. Loop up to maxRetries times (default: 5)
 *   4. If all pass → push
 *
 * This pipeline is focused on ensuring tests pass before pushing.
 */

import { definePipeline, node } from '@funny/pipelines';
import type { AgentDefinition } from '@funny/shared';

import { resolveSystemPrompt } from '../services/agent-registry.js';
import type { PipelineContext } from './types.js';

// ── Context ─────────────────────────────────────────────────

export interface PrePushPipelineContext extends PipelineContext {
  /** Test command to run (e.g. 'bun test', 'npm test'). */
  testCommand: string;
  /** Branch to push to. */
  branch?: string;

  // ── Config ─────────────────────────────────────────────
  /** Max test→fix retries. Default: 5. */
  maxRetries?: number;
  /** Agent definition for the test fixer. */
  fixer: AgentDefinition;

  // ── State (populated during execution) ─────────────────
  /** Whether tests passed on the last run. */
  testPassed: boolean;
  /** Output from the last test run (for fixer context). */
  testOutput?: string;
  /** Current attempt (1-based). */
  attempt: number;
}

// ── Pipeline ────────────────────────────────────────────────

export const prePushPipeline = definePipeline<PrePushPipelineContext>({
  name: 'pre-push',

  nodes: [
    // ── Run tests ──────────────────────────────────────────
    node('test-run', async (ctx) => {
      ctx.progress.onStepProgress('test-run', { status: 'running' });

      const result = await ctx.provider.runCommand({
        command: ctx.testCommand,
        cwd: ctx.cwd,
      });

      if (result.ok) {
        ctx.progress.onStepProgress('test-run', { status: 'completed' });

        ctx.progress.onPipelineEvent('test_run', {
          attempt: ctx.attempt,
          passed: true,
        });

        return { ...ctx, testPassed: true, testOutput: undefined };
      }

      // Tests failed
      ctx.progress.onStepProgress('test-run', {
        status: 'failed',
        error: 'Tests failed',
      });

      ctx.progress.onPipelineEvent('test_run', {
        attempt: ctx.attempt,
        passed: false,
      });

      return {
        ...ctx,
        testPassed: false,
        testOutput: result.error || result.output || 'Tests failed',
      };
    }),

    // ── Fix test failures (only if tests failed) ──────────
    node(
      'test-fix',
      async (ctx) => {
        const maxRetries = ctx.maxRetries ?? 5;

        if (ctx.attempt >= maxRetries) {
          ctx.progress.onStepProgress('test-fix', {
            status: 'failed',
            error: `Tests still failing after ${maxRetries} attempts`,
          });
          throw new Error(
            `Tests still failing after ${maxRetries} attempts. Last output:\n${ctx.testOutput}`,
          );
        }

        ctx.progress.onStepProgress('test-fix', {
          status: 'running',
          metadata: { attempt: ctx.attempt, maxRetries },
        });

        await ctx.provider.notify({
          message: `Tests failed (attempt ${ctx.attempt}/${maxRetries}). Spawning fixer agent...`,
          level: 'warning',
        });

        const fixerBase = resolveSystemPrompt(ctx.fixer);
        const prompt = `${fixerBase}\n\nThe test command \`${ctx.testCommand}\` failed (attempt ${ctx.attempt}) with the following output:\n\n\`\`\`\n${ctx.testOutput}\n\`\`\`\n\nAfter fixing, run the tests again with \`${ctx.testCommand}\` to verify they pass.\nDo NOT create a git commit — just fix the files and stage with \`git add\`.`;

        const fixResult = await ctx.provider.spawnAgent({
          prompt,
          cwd: ctx.cwd,
          agent: ctx.fixer,
          context: ctx.testOutput,
        });

        if (!fixResult.ok) {
          ctx.progress.onStepProgress('test-fix', {
            status: 'failed',
            error: `Test fixer agent failed: ${fixResult.error}`,
          });
          throw new Error(`Test fixer agent failed: ${fixResult.error}`);
        }

        // Commit the fix (skip hooks — they'll run when we push)
        const commitResult = await ctx.provider.gitCommit({
          cwd: ctx.cwd,
          message: `fix: address test failures (attempt ${ctx.attempt})`,
          noVerify: true,
        });

        if (!commitResult.ok) {
          ctx.progress.onStepProgress('test-fix', {
            status: 'failed',
            error: `Fix commit failed: ${commitResult.error}`,
          });
          throw new Error(`Fix commit failed: ${commitResult.error}`);
        }

        ctx.progress.onStepProgress('test-fix', { status: 'completed' });

        ctx.progress.onPipelineEvent('test_fix', {
          attempt: ctx.attempt,
          status: 'completed',
        });

        return {
          ...ctx,
          attempt: ctx.attempt + 1,
          testPassed: false,
          testOutput: undefined,
        };
      },
      { when: (ctx) => !ctx.testPassed },
    ),
  ],

  // Loop: test → fix → test until pass or max retries
  loop: {
    from: 'test-run',
    until: (ctx) => ctx.testPassed,
  },
});
