/**
 * pr-review-loop — Hatchet workflow for automated PR feedback application.
 *
 * Triggered when a human reviewer requests changes on an integration PR.
 * Three sequential tasks:
 *   1. Fetch unresolved review comments from GitHub
 *   2. Apply feedback using AgentExecutor (reads code, makes changes, commits)
 *   3. Push changes and check if PR is now approved
 *
 * If the PR is approved after pushing, emits `pr.approved` event to unblock
 * the `wait-for-approval` durable task in the feature-to-deploy workflow.
 */

import type { HatchetClient } from '@hatchet-dev/typescript-sdk/v1';
import { execute, fetchPRReviews, checkPRApprovalStatus } from '@funny/core/git';
import { AgentExecutor, ModelFactory } from '@funny/core/agents';
import type { AgentRole, AgentContext } from '@funny/core/agents';
import { logger } from '../../infrastructure/logger.js';

// ── Input/Output types ──────────────────────────────────────────

interface PRReviewLoopInput {
  projectPath: string;
  branch: string;
  integrationBranch: string;
  prNumber: number;
  prUrl: string;
  baseBranch: string;
  worktreePath?: string;
  model?: string;
  provider?: string;
  requestId?: string;
}

interface FetchReviewsOutput {
  comments: Array<{
    author: string;
    body: string;
    path: string;
    line: number | null;
  }>;
  reviewBodies: string[];
  hasActionableComments: boolean;
}

interface ApplyFeedbackOutput {
  status: string;
  changesApplied: number;
  commitSha: string;
}

interface PushAndCheckOutput {
  pushed: boolean;
  approvalStatus: string;
  approved: boolean;
}

type WorkflowOutput = {
  'fetch-reviews': FetchReviewsOutput;
  'apply-feedback': ApplyFeedbackOutput;
  'push-and-check': PushAndCheckOutput;
};

// ── Helpers ─────────────────────────────────────────────────────

function buildSystemPrompt(branch: string, prUrl: string): string {
  return `You are a code review feedback agent. A human reviewer has requested changes on a pull request.

## Context
- Branch: ${branch}
- PR: ${prUrl}

## Instructions
1. Read the review comments below carefully
2. For each comment, understand what changes are requested
3. Read the relevant files and apply the requested changes
4. If a comment is unclear, make your best judgment based on the context
5. After making all changes, commit with a descriptive message
6. Do NOT create new branches — work on the current branch

## Important
- Apply ALL requested changes, not just some
- Preserve existing functionality while making the requested changes
- Commit with message format: "fix(review): address PR feedback — <summary>"`;
}

function buildReviewPrompt(reviewData: FetchReviewsOutput): string {
  const parts: string[] = ['## Review Feedback to Address\n'];

  if (reviewData.reviewBodies.length > 0) {
    parts.push('### General Review Comments');
    for (const body of reviewData.reviewBodies) {
      parts.push(`> ${body}`);
    }
  }

  if (reviewData.comments.length > 0) {
    parts.push('\n### Inline Code Comments');
    for (const c of reviewData.comments) {
      const location = c.path + (c.line ? `:${c.line}` : '');
      parts.push(`**${location}** (by ${c.author}):\n> ${c.body}\n`);
    }
  }

  return parts.join('\n');
}

// ── Workflow registration ───────────────────────────────────────

export function registerPRReviewLoopWorkflow(hatchet: HatchetClient) {
  const workflow = hatchet.workflow<PRReviewLoopInput, WorkflowOutput>({
    name: 'pr-review-loop',
  });

  // Task 1: Fetch latest unresolved review comments
  const fetchReviews = workflow.task({
    name: 'fetch-reviews',
    executionTimeout: '5m',
    retries: 2,
    fn: async (input) => {
      const { prNumber } = input;
      const cwd = input.worktreePath ?? input.projectPath;

      const result = await fetchPRReviews(cwd, prNumber);
      const data = result.match(
        (val) => val,
        (err) => { throw new Error(`Failed to fetch PR reviews: ${err.message}`); },
      );

      // Extract actionable reviews (changes_requested) + all inline comments
      const changesRequestedReviews = data.reviews.filter(
        (r) => r.state === 'CHANGES_REQUESTED',
      );
      const reviewBodies = changesRequestedReviews
        .map((r) => r.body)
        .filter(Boolean);
      const comments = data.comments.map((c) => ({
        author: c.author,
        body: c.body,
        path: c.path,
        line: c.line,
      }));

      logger.info(
        { prNumber, reviewCount: reviewBodies.length, commentCount: comments.length },
        'Fetched PR review comments',
      );

      return {
        comments,
        reviewBodies,
        hasActionableComments: reviewBodies.length > 0 || comments.length > 0,
      } as FetchReviewsOutput;
    },
  });

  // Task 2: Apply feedback using AgentExecutor
  const applyFeedback = workflow.task({
    name: 'apply-feedback',
    parents: [fetchReviews],
    executionTimeout: '30m',
    retries: 1,
    fn: async (input, ctx) => {
      const reviewData = await ctx.parentOutput(fetchReviews);

      if (!reviewData.hasActionableComments) {
        logger.info({ prNumber: input.prNumber }, 'No actionable review comments — skipping');
        return { status: 'no_changes', changesApplied: 0, commitSha: '' } as ApplyFeedbackOutput;
      }

      const cwd = input.worktreePath ?? input.projectPath;
      const reviewPrompt = buildReviewPrompt(reviewData);

      const role: AgentRole = {
        name: 'review-feedback-applier',
        systemPrompt: buildSystemPrompt(input.branch, input.prUrl) + '\n\n' + reviewPrompt,
        model: input.model ?? 'claude-sonnet-4-5-20250929',
        provider: input.provider ?? 'anthropic',
        tools: [],
        maxTurns: 100,
      };

      const context: AgentContext = {
        branch: input.integrationBranch,
        worktreePath: cwd,
        tier: 'large',
        diffStats: { files_changed: 0, lines_added: 0, lines_deleted: 0, changed_files: [] },
        previousResults: [],
        baseBranch: input.baseBranch,
      };

      const modelFactory = new ModelFactory();
      const model = modelFactory.create(role.provider, role.model);
      const executor = new AgentExecutor(model);
      const result = await executor.execute(role, context);

      // Get the latest commit SHA
      const shaResult = await execute('git', ['rev-parse', 'HEAD'], { cwd, reject: false });
      const commitSha = shaResult.exitCode === 0 ? shaResult.stdout.trim() : '';

      logger.info(
        { prNumber: input.prNumber, status: result.status, fixes: result.fixes_applied, commitSha },
        'Review feedback applied',
      );

      return {
        status: result.status === 'error' ? 'error' : 'applied',
        changesApplied: result.fixes_applied,
        commitSha,
      } as ApplyFeedbackOutput;
    },
  });

  // Task 3: Push and check approval status
  workflow.task({
    name: 'push-and-check',
    parents: [applyFeedback],
    executionTimeout: '5m',
    retries: 2,
    fn: async (input, ctx) => {
      const feedbackResult = await ctx.parentOutput(applyFeedback);

      if (feedbackResult.status === 'no_changes') {
        return { pushed: false, approvalStatus: 'no_changes', approved: false } as PushAndCheckOutput;
      }

      const cwd = input.worktreePath ?? input.projectPath;

      // Push the changes
      await execute('git', ['push', 'origin', input.integrationBranch], { cwd });

      logger.info(
        { branch: input.integrationBranch, prNumber: input.prNumber },
        'Pushed review feedback changes',
      );

      // Check current approval status
      const statusResult = await checkPRApprovalStatus(cwd, input.prNumber);
      const decision = statusResult.match(
        (val) => val,
        () => '' as const,
      );

      const approved = decision === 'APPROVED';

      // If approved, emit pr.approved event to unblock feature-to-deploy wait
      if (approved) {
        await hatchet.event.push('pr.approved', {
          prNumber: input.prNumber,
          branch: input.branch,
        });
        logger.info({ prNumber: input.prNumber }, 'PR approved — emitted pr.approved event');
      }

      return { pushed: true, approvalStatus: decision, approved } as PushAndCheckOutput;
    },
  });

  return workflow;
}
