/**
 * Commit Pipeline
 *
 * Handles the commit flow with pre-commit hook auto-fix:
 *   1. Run git commit (which triggers pre-commit hooks)
 *   2. If hooks fail → spawn fixer agent → retry commit
 *   3. Repeat up to maxRetries times
 *
 * This pipeline is focused solely on getting a clean commit through.
 * It does NOT include code review or push — those are separate pipelines.
 */

import { definePipeline, node } from '@funny/pipelines';

import type { PipelineContext } from './types.js';

// ── Context ─────────────────────────────────────────────────

export interface CommitPipelineContext extends PipelineContext {
  /** Commit message. */
  commitMessage: string;
  /** Whether to amend the last commit instead of creating a new one. */
  amend?: boolean;
  /** Skip pre-commit hooks (--no-verify). */
  noVerify?: boolean;

  // ── Retry config ───────────────────────────────────────
  /** Max retries for pre-commit hook failures. Default: 3. */
  maxRetries?: number;
  /** Model to use for the fixer agent. */
  fixerModel?: string;
  /** Custom fixer prompt (replaces default). */
  fixerPrompt?: string;

  // ── State (populated during execution) ─────────────────
  /** Current attempt number (1-based). */
  attempt: number;
  /** Last hook error output (for fixer context). */
  lastHookError?: string;
  /** Whether the commit succeeded. */
  commitSucceeded?: boolean;
  /** SHA of the committed result. */
  commitSha?: string;
}

// ── Pipeline ────────────────────────────────────────────────

export const commitPipeline = definePipeline<CommitPipelineContext>({
  name: 'commit',

  nodes: [
    // ── Attempt commit ─────────────────────────────────────
    node('commit', async (ctx) => {
      const maxRetries = ctx.maxRetries ?? 3;

      ctx.progress.onStepProgress('commit', { status: 'running' });

      const result = await ctx.provider.gitCommit({
        cwd: ctx.cwd,
        message: ctx.commitMessage,
        amend: ctx.amend,
        noVerify: ctx.noVerify,
      });

      if (result.ok) {
        ctx.progress.onStepProgress('commit', { status: 'completed' });
        return {
          ...ctx,
          commitSucceeded: true,
          commitSha: result.metadata?.sha as string | undefined,
          lastHookError: undefined,
        };
      }

      // Hook failed — can we auto-fix?
      if (ctx.attempt >= maxRetries) {
        ctx.progress.onStepProgress('commit', {
          status: 'failed',
          error: `Commit failed after ${maxRetries} attempts`,
        });
        throw new Error(`Commit failed after ${maxRetries} attempts. Last error:\n${result.error}`);
      }

      // Store error for the fixer
      return { ...ctx, lastHookError: result.error || 'Pre-commit hook failed' };
    }),

    // ── Fix pre-commit errors (only if commit failed) ──────
    node(
      'fix-precommit',
      async (ctx) => {
        const maxRetries = ctx.maxRetries ?? 3;

        ctx.progress.onStepProgress('fix-precommit', {
          status: 'running',
          metadata: { attempt: ctx.attempt, maxRetries },
        });

        await ctx.provider.notify({
          message: `Pre-commit hook failed (attempt ${ctx.attempt}/${maxRetries}). Spawning fixer agent...`,
          level: 'warning',
        });

        const prompt = ctx.fixerPrompt
          ? `${ctx.fixerPrompt}\n\nError:\n${ctx.lastHookError}`
          : `A pre-commit hook failed with the following error:\n\n\`\`\`\n${ctx.lastHookError}\n\`\`\`\n\nFix the issues. After fixing, stage your changes with \`git add\`. Do NOT create a commit.`;

        const fixResult = await ctx.provider.spawnAgent({
          prompt,
          cwd: ctx.cwd,
          mode: 'autoEdit',
          model: ctx.fixerModel,
          context: ctx.lastHookError,
        });

        if (!fixResult.ok) {
          ctx.progress.onStepProgress('fix-precommit', {
            status: 'failed',
            error: `Fixer agent failed: ${fixResult.error}`,
          });
          throw new Error(`Fixer agent failed: ${fixResult.error}`);
        }

        ctx.progress.onStepProgress('fix-precommit', { status: 'completed' });

        ctx.progress.onPipelineEvent('precommit_fix', {
          attempt: ctx.attempt,
          status: 'completed',
        });

        // Increment attempt and clear error for next commit try
        return {
          ...ctx,
          attempt: ctx.attempt + 1,
          lastHookError: undefined,
        };
      },
      { when: (ctx) => !!ctx.lastHookError },
    ),
  ],

  // Loop: commit → fix → commit until commit succeeds
  loop: {
    from: 'commit',
    until: (ctx) => !!ctx.commitSucceeded,
  },
});
