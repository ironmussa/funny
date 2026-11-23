/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: core
 * @domain type: pipeline-node
 * @domain layer: application
 *
 * The review-fix sub-pipeline: a reviewer agent reviews the commit; on a
 * failing verdict a corrector agent fixes it in its own worktree, and its
 * patch is applied and committed on the parent thread. Loops until the
 * review passes or the corrector changes nothing.
 */
import { gitRead, gitWrite } from '@funny/core/git';
import { definePipeline, node } from '@funny/pipelines';

import { log } from '../../lib/logger.js';
import { parseReviewVerdict, cleanupReviewerThread } from '../pipeline-manager.js';
import { buildReviewerPrompt, buildCorrectorPrompt } from '../pipeline-prompts.js';
import * as tm from '../thread-manager.js';
import { createAndStartThread } from '../thread-service/create.js';
import { emitWorkflowEvent } from '../workflow-event-helpers.js';
import { waitForAgentCompletion } from './agent-completion.js';
import type { GitPipelineContext } from './context.js';
import { commitPipelineFix, resolveParentCwd } from './node-helpers.js';

async function reviewNode(
  ctx: GitPipelineContext,
  signal: AbortSignal,
): Promise<GitPipelineContext> {
  if (!ctx.threadId || !ctx.projectId) {
    throw new Error('Review requires threadId and projectId');
  }

  const parentThread = await tm.getThread(ctx.threadId);
  const baseBranch = parentThread?.branch || undefined;
  const prompt = buildReviewerPrompt(ctx.commitSha ?? undefined, ctx.reviewerPrompt);

  ctx.setStep('review', { status: 'running' });

  const reviewerThreadResult = await createAndStartThread({
    projectId: ctx.projectId,
    userId: ctx.userId,
    title: `Pipeline review (iteration ${ctx.iteration})`,
    mode: 'worktree',
    provider: 'claude',
    model: ctx.reviewModel,
    permissionMode: 'plan',
    source: 'automation',
    prompt,
    parentThreadId: ctx.threadId,
    baseBranch,
  });
  if (reviewerThreadResult.isErr()) throw reviewerThreadResult.error;
  const reviewerThread = reviewerThreadResult.value;

  log.info('Pipeline: reviewer thread created', {
    namespace: 'pipeline',
    reviewerThreadId: reviewerThread.id,
    baseBranch,
  });

  await waitForAgentCompletion(reviewerThread.id, signal);

  // Parse verdict from the last assistant message
  const reviewerWithMessages = await tm.getThreadWithMessages(reviewerThread.id);
  const lastAssistantMsg = reviewerWithMessages?.messages
    ? [...reviewerWithMessages.messages].reverse().find((m) => m.role === 'assistant')
    : null;

  if (!lastAssistantMsg) {
    await cleanupReviewerThread(reviewerThread.id, ctx.projectId);
    throw new Error('No assistant message from reviewer');
  }

  const { verdict, findings } = parseReviewVerdict(lastAssistantMsg.content);
  const reviewFindings = Array.isArray(findings) ? findings : [];

  await cleanupReviewerThread(reviewerThread.id, ctx.projectId);

  ctx.setStep('review', { status: 'completed' });

  // Emit workflow:review thread event
  if (ctx.threadId) {
    await emitWorkflowEvent(ctx.userId, ctx.threadId, 'workflow:review', {
      workflowId: ctx.workflowId,
      iteration: ctx.iteration,
      verdict,
      findingsCount: reviewFindings.length,
      reviewerThreadId: reviewerThread.id,
    });
  }

  return {
    ...ctx,
    reviewerThreadId: reviewerThread.id,
    verdict,
    findings: reviewFindings.length ? JSON.stringify(reviewFindings) : null,
  };
}

async function fixNode(ctx: GitPipelineContext, signal: AbortSignal): Promise<GitPipelineContext> {
  if (!ctx.threadId || !ctx.projectId) {
    throw new Error('Fix requires threadId and projectId');
  }

  const findingsStr =
    typeof ctx.findings === 'string' ? ctx.findings : JSON.stringify(ctx.findings, null, 2);
  const prompt = buildCorrectorPrompt(findingsStr, ctx.correctorPrompt);

  ctx.setStep('fix', { status: 'running' });

  const correctorThreadResult = await createAndStartThread({
    projectId: ctx.projectId,
    userId: ctx.userId,
    title: `Pipeline fix (iteration ${ctx.iteration})`,
    mode: 'worktree',
    provider: 'claude',
    model: ctx.fixModel,
    permissionMode: 'autoEdit',
    source: 'automation',
    prompt,
    parentThreadId: ctx.threadId,
  });
  if (correctorThreadResult.isErr()) throw correctorThreadResult.error;
  const correctorThread = correctorThreadResult.value;

  log.info('Pipeline: corrector thread created', {
    namespace: 'pipeline',
    correctorThreadId: correctorThread.id,
  });

  await waitForAgentCompletion(correctorThread.id, signal);

  // Check if the corrector made changes
  const correctorThreadData = await tm.getThread(correctorThread.id);
  const correctorCwd = correctorThreadData?.worktreePath || correctorThreadData?.initCwd;

  if (!correctorCwd) {
    throw new Error('Cannot resolve corrector working directory');
  }

  const statusResult = await gitRead(['status', '--porcelain'], {
    cwd: correctorCwd,
    reject: false,
  });
  const hasChanges = statusResult.exitCode === 0 && statusResult.stdout.trim().length > 0;

  if (!hasChanges) {
    log.info('Pipeline: corrector made no changes', { namespace: 'pipeline' });
    ctx.setStep('fix', { status: 'completed' });

    if (ctx.threadId) {
      await emitWorkflowEvent(ctx.userId, ctx.threadId, 'workflow:fix', {
        workflowId: ctx.workflowId,
        iteration: ctx.iteration,
        correctorThreadId: correctorThread.id,
        hasChanges: false,
      });
    }

    return { ...ctx, correctorThreadId: correctorThread.id, patchDiff: null, noChanges: true };
  }

  // Stage all and generate diff patch
  await gitRead(['add', '-A'], { cwd: correctorCwd, reject: false });
  const diffResult = await gitRead(['diff', '--cached'], { cwd: correctorCwd, reject: false });

  if (diffResult.exitCode !== 0 || !diffResult.stdout.trim()) {
    throw new Error('Failed to generate diff patch');
  }

  ctx.setStep('fix', { status: 'completed' });

  // Emit workflow:fix thread event
  if (ctx.threadId) {
    await emitWorkflowEvent(ctx.userId, ctx.threadId, 'workflow:fix', {
      workflowId: ctx.workflowId,
      iteration: ctx.iteration,
      correctorThreadId: correctorThread.id,
      hasChanges: true,
    });
  }

  return {
    ...ctx,
    correctorThreadId: correctorThread.id,
    patchDiff: diffResult.stdout,
    noChanges: false,
  };
}
async function applyPatchNode(ctx: GitPipelineContext): Promise<GitPipelineContext> {
  const targetCwd = await resolveParentCwd(ctx);

  if (!ctx.patchDiff) throw new Error('No patch diff available');

  const applyResult = await gitWrite(['apply', '--index', '-'], {
    cwd: targetCwd,
    stdin: ctx.patchDiff,
    reject: false,
  });

  if (applyResult.exitCode !== 0) {
    throw new Error(applyResult.stderr || 'git apply failed');
  }

  log.info('Pipeline: patch applied', { namespace: 'pipeline' });
  return ctx;
}

async function commitFixNode(ctx: GitPipelineContext): Promise<GitPipelineContext> {
  if (!ctx.threadId) throw new Error('Commit-fix requires threadId');
  const threadId = ctx.threadId;

  const targetCwd = await resolveParentCwd(ctx);
  const commitMessage = `fix: address review findings (iteration ${ctx.iteration})`;
  const committed = await commitPipelineFix({ ...ctx, threadId }, targetCwd, commitMessage);

  return {
    ...ctx,
    commitSha: committed.sha || ctx.commitSha,
    reviewerThreadId: null,
    correctorThreadId: null,
    patchDiff: null,
    verdict: null,
    findings: null,
    noChanges: false,
    iteration: ctx.iteration + 1,
  };
}

/** The review-fix sub-pipeline — used as a composable unit. */
export const reviewFixSubPipeline = definePipeline<GitPipelineContext>({
  name: 'review-fix',
  nodes: [
    node('review', reviewNode),
    node('fix', fixNode, { when: (ctx) => ctx.verdict === 'fail' }),
    node('apply-patch', applyPatchNode, { when: (ctx) => !!ctx.patchDiff }),
    node('commit-fix', commitFixNode, { when: (ctx) => !!ctx.patchDiff }),
  ],
  loop: {
    from: 'review',
    until: (ctx) => ctx.verdict === 'pass' || ctx.noChanges,
  },
});
