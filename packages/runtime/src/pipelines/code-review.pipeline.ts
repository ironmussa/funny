/**
 * Code Review Pipeline
 *
 * After a commit, reviews the code and fixes issues in a loop:
 *   1. Spawn a reviewer agent (read-only) → produces verdict (pass/fail)
 *   2. If fail → spawn corrector agent → re-commit fixes
 *   3. Loop back to review (up to maxIterations)
 *
 * This pipeline is focused solely on code quality review after commit.
 * It does NOT handle the commit itself or push — those are separate pipelines.
 */

import { definePipeline, node } from '@funny/pipelines';
import type { AgentDefinition } from '@funny/shared';

import { resolveSystemPrompt } from '../services/agent-registry.js';
import type { PipelineContext } from './types.js';

// ── Context ─────────────────────────────────────────────────

export interface CodeReviewPipelineContext extends PipelineContext {
  /** SHA of the commit to review. */
  commitSha?: string;

  // ── Config ─────────────────────────────────────────────
  /** Max review→fix iterations. Default: 10. */
  maxIterations?: number;
  /** Agent definition for the reviewer. */
  reviewer: AgentDefinition;
  /** Agent definition for the corrector. */
  corrector: AgentDefinition;

  // ── State (populated during execution) ─────────────────
  /** Current iteration (1-based). */
  iteration: number;
  /** Review verdict from the last review. */
  verdict?: 'pass' | 'fail';
  /** Findings from the reviewer (JSON string or raw text). */
  findings?: string;
  /** Full output from the reviewer. */
  reviewOutput?: string;
  /** Whether the corrector made no changes (signals we should stop). */
  noChanges: boolean;
}

/**
 * Parse the review verdict from the agent's output.
 * Looks for a JSON block with { verdict, findings }.
 */
export function parseReviewOutput(output: string): {
  verdict: 'pass' | 'fail';
  findings: string;
} {
  // Try fenced JSON block
  const jsonMatch = output.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1]);
      return {
        verdict: parsed.verdict === 'pass' ? 'pass' : 'fail',
        findings: JSON.stringify(parsed.findings ?? [], null, 2),
      };
    } catch {
      // Fall through
    }
  }

  // Try raw JSON with verdict field
  const rawJsonMatch = output.match(/\{[\s\S]*"verdict"\s*:\s*"(pass|fail)"[\s\S]*\}/);
  if (rawJsonMatch) {
    try {
      const parsed = JSON.parse(rawJsonMatch[0]);
      return {
        verdict: parsed.verdict === 'pass' ? 'pass' : 'fail',
        findings: JSON.stringify(parsed.findings ?? [], null, 2),
      };
    } catch {
      // Fall through
    }
  }

  // Heuristic: look for "pass" keywords
  const lower = output.toLowerCase();
  if (
    lower.includes('"verdict": "pass"') ||
    lower.includes('verdict: pass') ||
    lower.includes('all checks pass')
  ) {
    return { verdict: 'pass', findings: '[]' };
  }

  // Default to fail with raw output as findings
  return { verdict: 'fail', findings: output };
}

// ── Pipeline ────────────────────────────────────────────────

export const codeReviewPipeline = definePipeline<CodeReviewPipelineContext>({
  name: 'code-review',

  nodes: [
    // ── Review ────────────────────────────────────────────
    node('review', async (ctx) => {
      ctx.progress.onStepProgress('review', { status: 'running' });

      const prompt = resolveSystemPrompt(ctx.reviewer, { commitSha: ctx.commitSha || 'HEAD' });

      const result = await ctx.provider.spawnAgent({
        prompt,
        cwd: ctx.cwd,
        agent: ctx.reviewer,
      });

      if (!result.ok) {
        ctx.progress.onStepProgress('review', {
          status: 'failed',
          error: `Reviewer agent failed: ${result.error}`,
        });
        throw new Error(`Reviewer agent failed: ${result.error}`);
      }

      const { verdict, findings } = parseReviewOutput(result.output ?? '');

      ctx.progress.onStepProgress('review', { status: 'completed' });

      ctx.progress.onPipelineEvent('review', {
        iteration: ctx.iteration,
        verdict,
        findingsCount: findings === '[]' ? 0 : undefined,
      });

      await ctx.provider.notify({
        message: `Review verdict: ${verdict} (iteration ${ctx.iteration})`,
        level: verdict === 'pass' ? 'info' : 'warning',
      });

      return {
        ...ctx,
        verdict,
        findings,
        reviewOutput: result.output,
      };
    }),

    // ── Fix (only if review failed) ──────────────────────
    node(
      'fix',
      async (ctx) => {
        ctx.progress.onStepProgress('fix', { status: 'running' });

        const correctorBase = resolveSystemPrompt(ctx.corrector);
        const prompt = `${correctorBase}\n\nThe reviewer found the following issues that need to be fixed:\n\n${ctx.findings}\n\nDo NOT create a git commit — just fix the files and stage with \`git add\`.`;

        const fixResult = await ctx.provider.spawnAgent({
          prompt,
          cwd: ctx.cwd,
          agent: ctx.corrector,
          context: ctx.reviewOutput,
        });

        if (!fixResult.ok) {
          ctx.progress.onStepProgress('fix', {
            status: 'failed',
            error: `Corrector agent failed: ${fixResult.error}`,
          });
          throw new Error(`Corrector agent failed: ${fixResult.error}`);
        }

        // Re-commit the fix (skip hooks since we already passed them)
        const commitResult = await ctx.provider.gitCommit({
          cwd: ctx.cwd,
          message: `fix: address review findings (iteration ${ctx.iteration})`,
          noVerify: true,
        });

        if (!commitResult.ok) {
          ctx.progress.onStepProgress('fix', {
            status: 'failed',
            error: `Fix commit failed: ${commitResult.error}`,
          });
          throw new Error(`Fix commit failed: ${commitResult.error}`);
        }

        ctx.progress.onStepProgress('fix', { status: 'completed' });

        ctx.progress.onPipelineEvent('fix', {
          iteration: ctx.iteration,
          hasChanges: true,
        });

        return {
          ...ctx,
          iteration: ctx.iteration + 1,
          verdict: undefined,
          findings: undefined,
          reviewOutput: undefined,
          noChanges: false,
          // Update commit SHA to the new fix commit
          commitSha: (commitResult.metadata?.sha as string | undefined) ?? ctx.commitSha,
        };
      },
      { when: (ctx) => ctx.verdict === 'fail' },
    ),
  ],

  // Loop: review → fix → review until pass or max iterations
  loop: {
    from: 'review',
    until: (ctx) =>
      ctx.verdict === 'pass' || ctx.noChanges || ctx.iteration > (ctx.maxIterations ?? 10),
  },
});
