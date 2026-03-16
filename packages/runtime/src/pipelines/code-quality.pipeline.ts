/**
 * Code Quality Pipeline — Full Workflow Composition
 *
 * Composes the three individual pipelines into a complete flow:
 *   1. commit pipeline     → commit with pre-commit hook auto-fix
 *   2. code-review pipeline → review → fix loop (up to 10 iterations)
 *   3. pre-push pipeline   → run tests → fix loop (up to 5 retries)
 *   4. push                → push to remote (with retry)
 *   5. create PR           → open a pull request (non-fatal)
 *   6. notify              → report completion
 *
 * Each sub-pipeline can also be used independently for more granular control.
 * The code-quality pipeline maps its config fields to each sub-pipeline's
 * expected context shape.
 */

import { definePipeline, node, runPipeline } from '@funny/pipelines';
import type { AgentDefinition } from '@funny/shared';

import { codeReviewPipeline } from './code-review.pipeline.js';
import { commitPipeline } from './commit.pipeline.js';
import { prePushPipeline } from './pre-push.pipeline.js';
import type { PipelineContext } from './types.js';

// ── Context ─────────────────────────────────────────────────

export interface CodeQualityContext extends PipelineContext {
  /** Commit message for the initial commit. */
  commitMessage: string;
  /** Branch name (used for push and PR). */
  branch: string;
  /** Base branch for the PR (e.g. 'main'). */
  baseBranch?: string;

  // ── Commit config ──────────────────────────────────────
  /** Whether to amend the last commit. */
  amend?: boolean;
  /** Skip pre-commit hooks. */
  noVerify?: boolean;
  /** Max retries for commit pre-hook failures. Default: 3. */
  maxCommitRetries?: number;

  // ── Agent definitions ─────────────────────────────────
  /** Agent for reviewing code. */
  reviewer: AgentDefinition;
  /** Agent for correcting review findings. */
  corrector: AgentDefinition;
  /** Agent for fixing pre-commit hook failures. */
  precommitFixer: AgentDefinition;
  /** Agent for fixing test failures. */
  testFixer: AgentDefinition;

  // ── Review config ──────────────────────────────────────
  /** Max review→fix iterations. Default: 10. */
  maxReviewIterations?: number;

  // ── Test config ────────────────────────────────────────
  /** Test command (e.g. 'bun test'). If null/undefined, tests are skipped. */
  testCommand?: string;
  /** Max test→fix retries. Default: 5. */
  maxTestRetries?: number;

  // ── Push config ────────────────────────────────────────
  /** Max push retries. Default: 2. */
  maxPushRetries?: number;

  // ── State (populated during execution) ─────────────────
  commitSha?: string;
  reviewVerdict?: 'pass' | 'fail';
  reviewFindings?: string;
  reviewOutput?: string;
  prUrl?: string;
}

// ── Pipeline ────────────────────────────────────────────────

export const codeQualityPipeline = definePipeline<CodeQualityContext>({
  name: 'code-quality',

  nodes: [
    // ── 1. Commit (with pre-commit hook auto-fix) ────────
    node('commit', async (ctx, signal) => {
      const result = await runPipeline(
        commitPipeline,
        {
          ...ctx,
          maxRetries: ctx.maxCommitRetries,
          fixer: ctx.precommitFixer,
          attempt: 1,
        } as any,
        { signal },
      );

      if (result.outcome === 'failed') {
        throw new Error(result.error ?? 'Commit pipeline failed');
      }

      return {
        ...ctx,
        commitSha: (result.ctx as any).commitSha,
      };
    }),

    // ── 2. Code Review (review → fix loop) ───────────────
    node(
      'code-review',
      async (ctx, signal) => {
        const result = await runPipeline(
          codeReviewPipeline,
          {
            ...ctx,
            maxIterations: ctx.maxReviewIterations,
            iteration: 1,
            noChanges: false,
          } as any,
          { signal },
        );

        if (result.outcome === 'failed') {
          throw new Error(result.error ?? 'Code review pipeline failed');
        }

        const reviewCtx = result.ctx as any;
        return {
          ...ctx,
          commitSha: reviewCtx.commitSha ?? ctx.commitSha,
          reviewVerdict: reviewCtx.verdict,
          reviewFindings: reviewCtx.findings,
          reviewOutput: reviewCtx.reviewOutput,
        };
      },
      {
        when: (ctx) => !ctx.noVerify,
      },
    ),

    // ── 3. Pre-Push (test → fix loop) ───────────────────
    node(
      'pre-push',
      async (ctx, signal) => {
        const result = await runPipeline(
          prePushPipeline,
          {
            ...ctx,
            maxRetries: ctx.maxTestRetries,
            fixer: ctx.testFixer,
            testPassed: false,
            attempt: 1,
          } as any,
          { signal },
        );

        if (result.outcome === 'failed') {
          throw new Error(result.error ?? 'Pre-push pipeline failed');
        }

        return ctx;
      },
      {
        when: (ctx) => !!ctx.testCommand,
      },
    ),

    // ── 4. Push ──────────────────────────────────────────
    node('push', async (ctx) => {
      const maxRetries = ctx.maxPushRetries ?? 2;

      ctx.progress.onStepProgress('push', { status: 'running' });

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const result = await ctx.provider.gitPush({
          cwd: ctx.cwd,
          branch: ctx.branch,
          setUpstream: true,
        });

        if (result.ok) {
          ctx.progress.onStepProgress('push', { status: 'completed' });
          return ctx;
        }

        if (attempt === maxRetries) {
          ctx.progress.onStepProgress('push', {
            status: 'failed',
            error: `Push failed after ${maxRetries} attempts`,
          });
          throw new Error(`Push failed after ${maxRetries} attempts. Last error:\n${result.error}`);
        }

        await ctx.provider.notify({
          message: `Push failed (attempt ${attempt}/${maxRetries}). Spawning fixer agent...`,
          level: 'warning',
        });

        const fixResult = await ctx.provider.spawnAgent({
          prompt: `git push failed with:\n\n\`\`\`\n${result.error}\n\`\`\`\n\nDiagnose and fix the issue.`,
          cwd: ctx.cwd,
          mode: 'autoEdit',
          context: result.output,
        });

        if (!fixResult.ok) {
          throw new Error(`Push fixer agent failed: ${fixResult.error}`);
        }
      }

      throw new Error('Push failed');
    }),

    // ── 5. Create PR ─────────────────────────────────────
    node('create-pr', async (ctx) => {
      ctx.progress.onStepProgress('create-pr', { status: 'running' });

      const result = await ctx.provider.createPr({
        cwd: ctx.cwd,
        title: ctx.commitMessage,
        base: ctx.baseBranch,
      });

      if (!result.ok) {
        // PR creation failure is non-fatal
        ctx.progress.onStepProgress('create-pr', {
          status: 'completed',
          metadata: { warning: result.error },
        });
        await ctx.provider.notify({
          message: `PR creation failed: ${result.error}. You may need to create it manually.`,
          level: 'warning',
        });
        return ctx;
      }

      ctx.progress.onStepProgress('create-pr', { status: 'completed' });
      return { ...ctx, prUrl: result.output?.trim() };
    }),

    // ── 6. Notify ────────────────────────────────────────
    node('notify-done', async (ctx) => {
      const prInfo = ctx.prUrl ? ` PR: ${ctx.prUrl}` : '';
      await ctx.provider.notify({
        message: `Pipeline complete! Branch ${ctx.branch} pushed.${prInfo}`,
        level: 'info',
      });

      ctx.progress.onPipelineEvent('completed', {
        branch: ctx.branch,
        prUrl: ctx.prUrl,
      });

      return ctx;
    }),
  ],
});
