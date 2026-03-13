/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: core
 * @domain type: pipeline-definitions
 * @domain layer: application
 *
 * Composable pipeline definitions for all git workflow actions.
 *
 * Each action (commit, push, merge, etc.) is a pipeline composed from
 * reusable node groups:
 *   - stageNodes:     unstage → stage
 *   - commitNodes:    hooks (with auto-fix) → commit
 *   - reviewFixNodes: review → fix → apply-patch → commit-fix (loop)
 *   - pushNodes:      push
 *   - prNodes:        create PR
 *   - mergeNodes:     merge
 *
 * The commit pipeline includes the full flow:
 *   unstage? → stage? → hooks → commit → review → fix (loop)
 */

import {
  stageFiles as gitStageFiles,
  unstageFiles as gitUnstageFiles,
  commit as gitCommit,
  push as gitPush,
  runHookCommand,
  invalidateStatusCache,
  gitRead,
  gitWrite,
} from '@funny/core/git';
import {
  compose,
  definePipeline,
  node,
  subPipeline,
  type PipelineDefinition,
  type PipelineNode,
} from '@funny/pipelines';
import type {
  AgentModel,
  GitWorkflowAction,
  GitWorkflowProgressStep,
  PipelineVerdict,
  WSGitWorkflowProgressData,
} from '@funny/shared';

import { log } from '../lib/logger.js';
import {
  stage as gitServiceStage,
  unstage as gitServiceUnstage,
  commitChanges as gitServiceCommit,
  pushChanges as gitServicePush,
  merge as gitServiceMerge,
  createPullRequest as gitServiceCreatePR,
  resolveIdentity,
} from './git-service.js';
import { parseReviewVerdict, cleanupReviewerThread } from './pipeline-manager.js';
import {
  buildPrecommitFixerPrompt,
  buildReviewerPrompt,
  buildCorrectorPrompt,
  buildTestFixerPrompt,
} from './pipeline-prompts.js';
import * as pm from './project-manager.js';
import { threadEventBus } from './thread-event-bus.js';
import * as tm from './thread-manager.js';
import { createAndStartThread } from './thread-service.js';
import { emitWorkflowEvent } from './workflow-event-helpers.js';

// ── Unified pipeline context ─────────────────────────────────

export interface GitPipelineContext {
  // ── Identity / params ──────────────────────────────────
  contextId: string;
  threadId?: string;
  projectId?: string;
  userId: string;
  cwd: string;
  action: GitWorkflowAction;

  // ── Git operation params ───────────────────────────────
  message?: string;
  filesToStage?: string[];
  filesToUnstage?: string[];
  amend?: boolean;
  noVerify?: boolean;
  prTitle?: string;
  prBody?: string;
  targetBranch?: string;
  cleanup?: boolean;

  // ── Pre-commit hooks ───────────────────────────────────
  hooks: { label: string; command: string }[];

  // ── Pipeline config (for auto-fix + review) ────────────
  pipelineEnabled: boolean;
  precommitFixEnabled: boolean;
  precommitFixModel: AgentModel;
  precommitFixMaxIterations: number;
  reviewModel: AgentModel;
  fixModel: AgentModel;
  maxReviewIterations: number;

  // ── Custom prompt overrides ──────────────────────────
  reviewerPrompt?: string;
  correctorPrompt?: string;
  precommitFixerPrompt?: string;
  commitMessagePrompt?: string;
  testFixerPrompt?: string;

  // ── Test auto-fix config ────────────────────────────────
  testEnabled: boolean;
  testCommand: string | null;
  testFixEnabled: boolean;
  testFixModel: AgentModel;
  testFixMaxIterations: number;

  // ── Test auto-fix tracking ──────────────────────────────
  testOutput: string | null;
  testPassed: boolean;
  testIteration: number;
  testFixerThreadId: string | null;

  // ── Review-fix tracking ────────────────────────────────
  commitSha: string | null;
  iteration: number;
  reviewerThreadId: string | null;
  verdict: PipelineVerdict | null;
  findings: string | null;
  correctorThreadId: string | null;
  patchDiff: string | null;
  noChanges: boolean;

  // ── Progress tracking ──────────────────────────────────
  steps: GitWorkflowProgressStep[];
  prUrl?: string;
  workflowId: string;

  // ── Helpers (bound at creation) ────────────────────────
  emit: (status: WSGitWorkflowProgressData['status']) => void;
  setStep: (stepId: string, update: Partial<GitWorkflowProgressStep>) => void;
}

// ── Stage nodes ──────────────────────────────────────────────

async function unstageNode(ctx: GitPipelineContext): Promise<GitPipelineContext> {
  ctx.setStep('unstage', { status: 'running' });

  if (ctx.threadId) {
    const result = await gitServiceUnstage(
      ctx.threadId,
      ctx.userId,
      ctx.cwd,
      ctx.filesToUnstage!,
      ctx.workflowId,
    );
    if (result.isErr()) {
      const e = result.error;
      throw new Error(e.type === 'PROCESS_ERROR' ? e.stderr || e.message : e.message);
    }
  } else {
    const result = await gitUnstageFiles(ctx.cwd, ctx.filesToUnstage!);
    if (result.isErr()) throw new Error(result.error.message);
  }

  ctx.setStep('unstage', { status: 'completed' });
  return ctx;
}

async function stageNode(ctx: GitPipelineContext): Promise<GitPipelineContext> {
  ctx.setStep('stage', { status: 'running' });

  if (ctx.threadId) {
    const result = await gitServiceStage(
      ctx.threadId,
      ctx.userId,
      ctx.cwd,
      ctx.filesToStage!,
      ctx.workflowId,
    );
    if (result.isErr()) {
      const e = result.error;
      throw new Error(e.type === 'PROCESS_ERROR' ? e.stderr || e.message : e.message);
    }
  } else {
    const result = await gitStageFiles(ctx.cwd, ctx.filesToStage!);
    if (result.isErr()) throw new Error(result.error.message);
  }

  ctx.setStep('stage', { status: 'completed' });
  return ctx;
}

export const stageNodes: PipelineNode<GitPipelineContext>[] = [
  node('unstage', unstageNode, {
    when: (ctx) => !!(ctx.filesToUnstage && ctx.filesToUnstage.length > 0),
  }),
  node('stage', stageNode, {
    when: (ctx) => !!(ctx.filesToStage && ctx.filesToStage.length > 0),
  }),
];

// ── Commit nodes (hooks + commit) ────────────────────────────

async function hooksNode(ctx: GitPipelineContext): Promise<GitPipelineContext> {
  ctx.setStep('hooks', { status: 'running' });

  if (ctx.hooks.length > 0) {
    for (let i = 0; i < ctx.hooks.length; i++) {
      // Mark current hook running, previous completed
      const subItems = ctx.hooks.map((h, idx) => ({
        label: h.label,
        status: (idx < i ? 'completed' : idx === i ? 'running' : 'pending') as
          | 'pending'
          | 'running'
          | 'completed'
          | 'failed',
      }));
      ctx.setStep('hooks', { status: 'running', subItems });

      const hookResult = await runHookCommand(ctx.cwd, ctx.hooks[i].command);

      if (!hookResult.success) {
        // Check if we can auto-fix this hook failure
        const canAutoFix = ctx.pipelineEnabled && ctx.precommitFixEnabled && !ctx.noVerify;

        if (canAutoFix) {
          const fixed = await attemptPrecommitAutoFix({
            cwd: ctx.cwd,
            userId: ctx.userId,
            threadId: ctx.threadId,
            projectId: ctx.projectId,
            workflowId: ctx.workflowId,
            hookLabel: ctx.hooks[i].label,
            hookCommand: ctx.hooks[i].command,
            hookError: hookResult.output || 'Hook failed',
            fixModel: ctx.precommitFixModel,
            maxIterations: ctx.precommitFixMaxIterations,
            setStep: ctx.setStep,
            hooks: ctx.hooks,
            hookIndex: i,
          });

          if (fixed) continue;
        }

        // Not auto-fixable or auto-fix failed
        const failedSubItems = ctx.hooks.map((h, idx) => ({
          label: h.label,
          status: (idx < i ? 'completed' : idx === i ? 'failed' : 'pending') as
            | 'pending'
            | 'running'
            | 'completed'
            | 'failed',
          error: idx === i ? hookResult.output : undefined,
        }));
        ctx.setStep('hooks', {
          status: 'failed',
          subItems: failedSubItems,
          error: hookResult.output,
        });

        // Emit workflow:hooks failure event
        if (ctx.threadId) {
          await emitWorkflowEvent(ctx.userId, ctx.threadId, 'workflow:hooks', {
            workflowId: ctx.workflowId,
            status: 'failed',
            hooks: failedSubItems.map((s) => ({
              label: s.label,
              status: s.status,
              error: s.error,
            })),
            failedHook: ctx.hooks[i].label,
          });
        }

        throw new HookFailedError(ctx.hooks[i].label, hookResult.output || 'Hook failed');
      }
    }

    // All hooks passed
    const completedSubItems = ctx.hooks.map((h) => ({
      label: h.label,
      status: 'completed' as const,
    }));
    ctx.setStep('hooks', { status: 'completed', subItems: completedSubItems });

    // Emit workflow:hooks thread event
    if (ctx.threadId) {
      await emitWorkflowEvent(ctx.userId, ctx.threadId, 'workflow:hooks', {
        workflowId: ctx.workflowId,
        status: 'completed',
        hooks: ctx.hooks.map((h) => ({ label: h.label, status: 'completed' })),
      });
    }
  } else {
    ctx.setStep('hooks', { status: 'completed' });
  }

  return ctx;
}

async function commitNode(ctx: GitPipelineContext): Promise<GitPipelineContext> {
  ctx.setStep('commit', { status: 'running' });

  const isAmend = ctx.action === 'amend';
  // Skip built-in hooks since we already ran them individually
  const noVerify = ctx.hooks.length > 0;

  // If review-fix will run after this commit, mark the git:committed event
  // so the pipeline-trigger-handler doesn't start a separate review pipeline.
  const willReview = ctx.pipelineEnabled && !!ctx.threadId && !!ctx.projectId;
  const patchListener = willReview
    ? (event: { isPipelineCommit?: boolean }) => {
        event.isPipelineCommit = true;
      }
    : null;

  if (patchListener) {
    threadEventBus.on('git:committed', patchListener as any);
  }

  try {
    if (ctx.threadId) {
      const result = await gitServiceCommit(
        ctx.threadId,
        ctx.userId,
        ctx.cwd,
        ctx.message!,
        isAmend,
        noVerify,
        ctx.workflowId,
      );
      if (result.isErr()) {
        const e = result.error;
        const errorMsg = e.type === 'PROCESS_ERROR' ? e.stderr || e.message : e.message;
        throw new Error(errorMsg);
      }
    } else {
      const identity = await resolveIdentity(ctx.userId);
      const result = await gitCommit(ctx.cwd, ctx.message!, identity, isAmend, noVerify);
      if (result.isErr()) {
        const e = result.error;
        throw new Error(e.type === 'PROCESS_ERROR' ? e.stderr || e.message : e.message);
      }
      invalidateStatusCache(ctx.cwd);
    }
  } catch (e: any) {
    const errorMsg = e.stderr || e.message || 'Commit failed';
    ctx.setStep('commit', { status: 'failed', error: errorMsg });
    throw new Error(errorMsg, { cause: e });
  } finally {
    if (patchListener) {
      threadEventBus.removeListener('git:committed', patchListener as any);
    }
  }

  // Capture commit SHA for review
  const shaResult = await gitRead(['rev-parse', 'HEAD'], { cwd: ctx.cwd, reject: false });
  if (shaResult.exitCode === 0) {
    ctx.commitSha = shaResult.stdout.trim();
  }

  ctx.setStep('commit', { status: 'completed' });
  return ctx;
}

export const commitNodes: PipelineNode<GitPipelineContext>[] = [
  node('hooks', hooksNode),
  node('commit', commitNode),
];

// ── Review-fix nodes (reviewer agent → corrector agent loop) ─

/**
 * Wait for an agent to complete via the event bus.
 */
function waitForAgentCompletion(
  threadId: string,
  signal: AbortSignal,
): Promise<{ status: string }> {
  return new Promise((resolve, reject) => {
    const onCompleted = (event: { threadId: string; status: string }) => {
      if (event.threadId !== threadId) return;
      cleanup();
      resolve({ status: event.status });
    };

    const onAbort = () => {
      cleanup();
      reject(new Error('Pipeline cancelled'));
    };

    const cleanup = () => {
      threadEventBus.removeListener('agent:completed', onCompleted as any);
      signal.removeEventListener('abort', onAbort);
    };

    threadEventBus.on('agent:completed', onCompleted as any);
    signal.addEventListener('abort', onAbort);

    if (signal.aborted) {
      cleanup();
      reject(new Error('Pipeline cancelled'));
    }
  });
}

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

  const reviewerThread = await createAndStartThread({
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

  await cleanupReviewerThread(reviewerThread.id, ctx.projectId);

  ctx.setStep('review', { status: 'completed' });

  // Emit workflow:review thread event
  if (ctx.threadId) {
    await emitWorkflowEvent(ctx.userId, ctx.threadId, 'workflow:review', {
      workflowId: ctx.workflowId,
      iteration: ctx.iteration,
      verdict,
      findingsCount: findings?.length ?? 0,
      reviewerThreadId: reviewerThread.id,
    });
  }

  return {
    ...ctx,
    reviewerThreadId: reviewerThread.id,
    verdict,
    findings: findings ? JSON.stringify(findings) : null,
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

  const correctorThread = await createAndStartThread({
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
  const parentThread = ctx.threadId ? await tm.getThread(ctx.threadId) : null;
  const parentCwd = parentThread?.worktreePath || parentThread?.initCwd;
  const project = ctx.projectId ? await pm.getProject(ctx.projectId) : null;
  const targetCwd = parentCwd || project?.path || ctx.cwd;

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

  const parentThread = await tm.getThread(ctx.threadId);
  const parentCwd = parentThread?.worktreePath || parentThread?.initCwd;
  const project = ctx.projectId ? await pm.getProject(ctx.projectId) : null;
  const targetCwd = parentCwd || project?.path || ctx.cwd;

  const commitMessage = `fix: address review findings (iteration ${ctx.iteration})`;

  const { commitChanges } = await import('./git-service.js');

  // Mark git:committed as a pipeline commit so trigger handler skips it
  const patchListener = (event: { isPipelineCommit?: boolean }) => {
    event.isPipelineCommit = true;
  };
  threadEventBus.on('git:committed', patchListener as any);

  try {
    const result = await commitChanges(
      ctx.threadId,
      ctx.userId,
      targetCwd,
      commitMessage,
      false,
      true,
      ctx.workflowId,
    );
    if (result.isErr()) {
      const e = result.error;
      throw new Error(e.type === 'PROCESS_ERROR' ? e.stderr || e.message : e.message);
    }

    const shaResult = await gitRead(['rev-parse', 'HEAD'], { cwd: targetCwd, reject: false });
    const newSha = shaResult.exitCode === 0 ? shaResult.stdout.trim() : undefined;

    return {
      ...ctx,
      commitSha: newSha || ctx.commitSha,
      reviewerThreadId: null,
      correctorThreadId: null,
      patchDiff: null,
      verdict: null,
      findings: null,
      noChanges: false,
      iteration: ctx.iteration + 1,
    };
  } finally {
    threadEventBus.removeListener('git:committed', patchListener as any);
  }
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

// ── Test auto-fix nodes (run tests → fix failures loop) ─────

async function testRunnerNode(ctx: GitPipelineContext): Promise<GitPipelineContext> {
  if (!ctx.testCommand) throw new Error('Test command is required');

  ctx.setStep('test-run', { status: 'running' });

  const result = await runHookCommand(ctx.cwd, ctx.testCommand);

  if (result.success) {
    log.info('Pipeline: tests passed', { namespace: 'pipeline', iteration: ctx.testIteration });
    ctx.setStep('test-run', { status: 'completed' });

    if (ctx.threadId) {
      await emitWorkflowEvent(ctx.userId, ctx.threadId, 'workflow:test_run', {
        workflowId: ctx.workflowId,
        iteration: ctx.testIteration,
        passed: true,
      });
    }

    return { ...ctx, testPassed: true, testOutput: null };
  }

  log.info('Pipeline: tests failed', {
    namespace: 'pipeline',
    iteration: ctx.testIteration,
    output: (result.output || '').slice(0, 500),
  });

  ctx.setStep('test-run', { status: 'failed', error: 'Tests failed' });

  if (ctx.threadId) {
    await emitWorkflowEvent(ctx.userId, ctx.threadId, 'workflow:test_run', {
      workflowId: ctx.workflowId,
      iteration: ctx.testIteration,
      passed: false,
    });
  }

  return { ...ctx, testPassed: false, testOutput: result.output || 'Tests failed' };
}

async function testFixerNode(ctx: GitPipelineContext): Promise<GitPipelineContext> {
  if (!ctx.threadId || !ctx.projectId) {
    throw new Error('Test fixer requires threadId and projectId');
  }
  if (!ctx.testCommand || !ctx.testOutput) {
    throw new Error('Test fixer requires testCommand and testOutput');
  }

  ctx.setStep('test-fixer', { status: 'running' });

  const prompt = buildTestFixerPrompt(
    ctx.testCommand,
    ctx.testOutput,
    ctx.testIteration,
    ctx.testFixerPrompt,
  );

  const fixerThread = await createAndStartThread({
    projectId: ctx.projectId,
    userId: ctx.userId,
    title: `Test fix (iteration ${ctx.testIteration})`,
    mode: 'local',
    provider: 'claude',
    model: ctx.testFixModel,
    permissionMode: 'autoEdit',
    source: 'automation',
    prompt,
    parentThreadId: ctx.threadId,
  });

  log.info('Pipeline: test fixer thread created', {
    namespace: 'pipeline',
    fixerThreadId: fixerThread.id,
    iteration: ctx.testIteration,
  });

  await waitForAgentCompletionPoll(fixerThread.id);

  // Stage changes and commit as a pipeline commit
  const parentThread = await tm.getThread(ctx.threadId);
  const targetCwd = parentThread?.worktreePath || parentThread?.initCwd || ctx.cwd;

  await gitRead(['add', '-A'], { cwd: targetCwd, reject: false });

  // Check if there are staged changes to commit
  const statusResult = await gitRead(['status', '--porcelain'], {
    cwd: targetCwd,
    reject: false,
  });
  const hasChanges = statusResult.exitCode === 0 && statusResult.stdout.trim().length > 0;

  if (hasChanges) {
    const commitMessage = `fix: address test failures (iteration ${ctx.testIteration})`;

    // Mark as pipeline commit to prevent re-triggering review
    const patchListener = (event: { isPipelineCommit?: boolean }) => {
      event.isPipelineCommit = true;
    };
    threadEventBus.on('git:committed', patchListener as any);

    try {
      const { commitChanges } = await import('./git-service.js');
      const commitResult = await commitChanges(
        ctx.threadId,
        ctx.userId,
        targetCwd,
        commitMessage,
        false,
        true,
        ctx.workflowId,
      );
      if (commitResult.isErr()) {
        const e = commitResult.error;
        throw new Error(e.type === 'PROCESS_ERROR' ? e.stderr || e.message : e.message);
      }
    } finally {
      threadEventBus.removeListener('git:committed', patchListener as any);
    }
  }

  ctx.setStep('test-fixer', { status: 'completed' });

  if (ctx.threadId) {
    await emitWorkflowEvent(ctx.userId, ctx.threadId, 'workflow:test_fix', {
      workflowId: ctx.workflowId,
      iteration: ctx.testIteration,
      fixerThreadId: fixerThread.id,
      hasChanges,
    });
  }

  return {
    ...ctx,
    testFixerThreadId: fixerThread.id,
    testOutput: null,
    testPassed: false,
    testIteration: ctx.testIteration + 1,
  };
}

/** The test-fix sub-pipeline — runs tests then fixes failures in a loop. */
export const testFixSubPipeline = definePipeline<GitPipelineContext>({
  name: 'test-fix',
  nodes: [
    node('test-run', testRunnerNode),
    node('test-fixer', testFixerNode, {
      when: (ctx) => !ctx.testPassed && ctx.testFixEnabled,
    }),
  ],
  loop: {
    from: 'test-run',
    until: (ctx) => ctx.testPassed || !ctx.testFixEnabled,
  },
});

// ── Push / PR / Merge nodes ──────────────────────────────────

async function pushNode(ctx: GitPipelineContext): Promise<GitPipelineContext> {
  ctx.setStep('push', { status: 'running' });

  try {
    if (ctx.threadId) {
      const result = await gitServicePush(ctx.threadId, ctx.userId, ctx.cwd, ctx.workflowId);
      if (result.isErr()) {
        const e = result.error;
        throw new Error(e.type === 'PROCESS_ERROR' ? e.stderr || e.message : e.message);
      }
    } else {
      const identity = await resolveIdentity(ctx.userId);
      const result = await gitPush(ctx.cwd, identity);
      if (result.isErr()) {
        const e = result.error;
        throw new Error(e.type === 'PROCESS_ERROR' ? e.stderr || e.message : e.message);
      }
      invalidateStatusCache(ctx.cwd);
    }
  } catch (e: any) {
    ctx.setStep('push', { status: 'failed', error: e.message || 'Push failed' });
    throw new Error(e.message || 'Push failed', { cause: e });
  }

  ctx.setStep('push', { status: 'completed' });
  return ctx;
}

async function prNode(ctx: GitPipelineContext): Promise<GitPipelineContext> {
  ctx.setStep('pr', { status: 'running' });

  try {
    if (!ctx.threadId) throw new Error('PR creation requires a thread');
    const result = await gitServiceCreatePR({
      threadId: ctx.threadId,
      userId: ctx.userId,
      cwd: ctx.cwd,
      title: ctx.prTitle || ctx.message || '',
      body: ctx.prBody || '',
    });
    if (result.isErr()) {
      const e = result.error;
      throw new Error(e.type === 'PROCESS_ERROR' ? e.stderr || e.message : e.message);
    }
    const prUrl = result.value;
    ctx.setStep('pr', { status: 'completed', url: prUrl || undefined });
    ctx.prUrl = prUrl || undefined;
  } catch (e: any) {
    ctx.setStep('pr', { status: 'failed', error: e.message || 'PR creation failed' });
    throw new Error(e.message || 'PR creation failed', { cause: e });
  }

  return ctx;
}

async function mergeNode(ctx: GitPipelineContext): Promise<GitPipelineContext> {
  ctx.setStep('merge', { status: 'running' });

  try {
    if (!ctx.threadId) throw new Error('Merge requires a thread');
    const result = await gitServiceMerge({
      threadId: ctx.threadId,
      userId: ctx.userId,
      targetBranch: ctx.targetBranch,
      cleanup: ctx.cleanup,
    });
    if (result.isErr()) {
      const e = result.error;
      throw new Error(e.type === 'PROCESS_ERROR' ? e.stderr || e.message : e.message);
    }
  } catch (e: any) {
    ctx.setStep('merge', { status: 'failed', error: e.message || 'Merge failed' });
    throw new Error(e.message || 'Merge failed', { cause: e });
  }

  ctx.setStep('merge', { status: 'completed' });
  return ctx;
}

export const pushNodes: PipelineNode<GitPipelineContext>[] = [node('push', pushNode)];
export const prNodes: PipelineNode<GitPipelineContext>[] = [node('pr', prNode)];
export const mergeNodes: PipelineNode<GitPipelineContext>[] = [node('merge', mergeNode)];

// ── Pipeline definitions (one per action) ────────────────────

/** Shared review-fix sub-pipeline node — used by all commit-based pipelines. */
const reviewFixNode = subPipeline('review-fix', reviewFixSubPipeline, {
  when: (ctx) => ctx.pipelineEnabled && !!ctx.threadId && !!ctx.projectId,
});

/** Shared test-fix sub-pipeline node — runs after review-fix. */
const testFixNode = subPipeline('test-fix', testFixSubPipeline, {
  when: (ctx) => ctx.testEnabled && !!ctx.testCommand && !!ctx.threadId && !!ctx.projectId,
});

/** Build a commit-based pipeline: stage → commit → review-fix → test-fix → ...tail */
function commitPipelineWith(name: string, ...tail: PipelineNode<GitPipelineContext>[][]) {
  return definePipeline<GitPipelineContext>({
    name,
    nodes: compose(stageNodes, commitNodes, [reviewFixNode], [testFixNode], ...tail),
  });
}

export const commitPipeline = commitPipelineWith('git:commit');
export const commitPushPipeline = commitPipelineWith('git:commit-push', pushNodes);
export const commitPrPipeline = commitPipelineWith('git:commit-pr', pushNodes, prNodes);
export const commitMergePipeline = commitPipelineWith('git:commit-merge', mergeNodes);

export const pushPipeline = definePipeline<GitPipelineContext>({
  name: 'git:push',
  nodes: pushNodes,
});

export const mergePipeline = definePipeline<GitPipelineContext>({
  name: 'git:merge',
  nodes: mergeNodes,
});

export const createPrPipeline = definePipeline<GitPipelineContext>({
  name: 'git:create-pr',
  nodes: compose(pushNodes, prNodes),
});

/** Get the pipeline definition for a given action. */
export function getActionPipeline(
  action: GitWorkflowAction,
): PipelineDefinition<GitPipelineContext> {
  switch (action) {
    case 'commit':
    case 'amend':
      return commitPipeline;
    case 'commit-push':
      return commitPushPipeline;
    case 'commit-pr':
      return commitPrPipeline;
    case 'commit-merge':
      return commitMergePipeline;
    case 'push':
      return pushPipeline;
    case 'merge':
      return mergePipeline;
    case 'create-pr':
      return createPrPipeline;
  }
}

// ── Step derivation ──────────────────────────────────────────

/** Human-readable labels for each pipeline node, keyed by node name. */
const STEP_LABELS: Record<string, string> = {
  unstage: 'Unstaging files',
  stage: 'Staging files',
  hooks: 'Running pre-commit hooks',
  commit: 'Committing',
  review: 'Reviewing code',
  fix: 'Fixing issues',
  'test-run': 'Running tests',
  'test-fixer': 'Fixing test failures',
  push: 'Pushing',
  pr: 'Creating pull request',
  merge: 'Merging',
};

/**
 * Derive the progress steps array by walking the pipeline's node list
 * and evaluating guards against the initial context. This replaces the
 * hand-built `buildSteps()` that duplicated pipeline composition logic.
 *
 * Sub-pipeline nodes (e.g. review-fix) are expanded into their child nodes.
 */
export function deriveSteps(
  pipeline: PipelineDefinition<GitPipelineContext>,
  ctx: GitPipelineContext,
): GitWorkflowProgressStep[] {
  const steps: GitWorkflowProgressStep[] = [];

  for (const n of pipeline.nodes) {
    // Skip guarded-out nodes
    if (n.when && !n.when(ctx)) continue;

    // Expand the review-fix sub-pipeline into its visible child nodes.
    // Guards on child nodes are NOT evaluated here — they depend on runtime
    // state (e.g. verdict), not on the initial context. We show only the
    // user-facing steps (review + fix), skipping internal ones (apply-patch,
    // commit-fix) that don't have UI labels.
    if (n.name === 'review-fix') {
      for (const child of reviewFixSubPipeline.nodes) {
        const label = STEP_LABELS[child.name];
        if (!label) continue; // skip internal nodes without UI labels
        steps.push({ id: child.name, label, status: 'pending' });
      }
      continue;
    }

    if (n.name === 'test-fix') {
      for (const child of testFixSubPipeline.nodes) {
        const label = STEP_LABELS[child.name];
        if (!label) continue;
        steps.push({ id: child.name, label, status: 'pending' });
      }
      continue;
    }

    const step: GitWorkflowProgressStep = {
      id: n.name,
      label:
        n.name === 'commit' && ctx.action === 'amend'
          ? 'Amending commit'
          : (STEP_LABELS[n.name] ?? n.name),
      status: 'pending',
    };

    // Add hook sub-items if this is the hooks step
    if (n.name === 'hooks' && ctx.hooks.length > 0) {
      step.subItems = ctx.hooks.map((h) => ({
        label: h.label,
        status: 'pending' as const,
      }));
    }

    steps.push(step);
  }

  return steps;
}

// ── Pre-commit auto-fix (moved from git-workflow-service) ────

class HookFailedError extends Error {
  constructor(
    public hookLabel: string,
    public hookOutput: string,
  ) {
    super(`Hook "${hookLabel}" failed: ${hookOutput}`);
    this.name = 'HookFailedError';
  }
}

interface AutoFixParams {
  cwd: string;
  userId: string;
  threadId?: string;
  projectId?: string;
  workflowId: string;
  hookLabel: string;
  hookCommand: string;
  hookError: string;
  fixModel: string;
  maxIterations: number;
  setStep: (stepId: string, update: Partial<GitWorkflowProgressStep>) => void;
  hooks: { label: string; command: string }[];
  hookIndex: number;
}

async function attemptPrecommitAutoFix(params: AutoFixParams): Promise<boolean> {
  const {
    cwd,
    userId,
    threadId,
    projectId,
    workflowId,
    hookLabel,
    hookCommand,
    hookError,
    fixModel,
    maxIterations,
  } = params;

  if (!projectId) {
    log.warn('Pre-commit auto-fix: no projectId, skipping', { namespace: 'pipeline' });
    return false;
  }

  log.info('Pre-commit auto-fix: starting', {
    namespace: 'pipeline',
    hookLabel,
    maxIterations,
  });

  for (let attempt = 1; attempt <= maxIterations; attempt++) {
    const fixingSubItems = params.hooks.map((h, idx) => ({
      label: idx === params.hookIndex ? `${h.label} (auto-fixing, attempt ${attempt})` : h.label,
      status: (idx < params.hookIndex
        ? 'completed'
        : idx === params.hookIndex
          ? 'running'
          : 'pending') as 'pending' | 'running' | 'completed' | 'failed',
    }));
    params.setStep('hooks', { status: 'running', subItems: fixingSubItems });

    let stagedFiles: string[] = [];
    try {
      const result = await gitRead(['diff', '--cached', '--name-only'], {
        cwd,
        reject: false,
      });
      if (result.exitCode === 0) {
        stagedFiles = result.stdout.trim().split('\n').filter(Boolean);
      }
    } catch {
      // Non-critical
    }

    const prompt = buildPrecommitFixerPrompt(
      hookLabel,
      hookError,
      stagedFiles,
      ctx.precommitFixerPrompt,
    );

    // Create a separate thread for the fixer agent
    let fixerThread: { id: string };
    try {
      fixerThread = await createAndStartThread({
        projectId,
        userId,
        title: `Pre-commit fix: ${hookLabel} (attempt ${attempt})`,
        mode: 'local',
        provider: 'claude',
        model: fixModel,
        permissionMode: 'autoEdit',
        source: 'automation',
        prompt,
        parentThreadId: threadId,
      });

      log.info('Pre-commit auto-fix: fixer thread created', {
        namespace: 'pipeline',
        fixerThreadId: fixerThread.id,
        attempt,
      });

      await waitForAgentCompletionPoll(fixerThread.id);

      // Emit a single workflow:precommit_fix event (consistent with workflow:review / workflow:fix)
      if (threadId) {
        await emitWorkflowEvent(userId, threadId, 'workflow:precommit_fix', {
          workflowId,
          hookLabel,
          attempt,
          fixerThreadId: fixerThread.id,
          status: 'completed',
        });
      }
    } catch (err) {
      log.error('Pre-commit auto-fix: agent failed', {
        namespace: 'pipeline',
        attempt,
        error: String(err),
      });
      return false;
    }

    const retryResult = await runHookCommand(cwd, hookCommand);
    if (retryResult.success) {
      log.info('Pre-commit auto-fix: hook now passes', {
        namespace: 'pipeline',
        hookLabel,
        attempt,
      });
      return true;
    }

    log.info('Pre-commit auto-fix: hook still failing', {
      namespace: 'pipeline',
      hookLabel,
      attempt,
      error: retryResult.output,
    });
  }

  log.warn('Pre-commit auto-fix: max iterations reached', {
    namespace: 'pipeline',
    hookLabel,
    maxIterations,
  });
  return false;
}

/** Poll-based agent completion (used for pre-commit fixer). */
async function waitForAgentCompletionPoll(threadId: string, timeoutMs = 300_000): Promise<void> {
  const { isAgentRunning } = await import('./agent-runner.js');
  const start = Date.now();
  const pollInterval = 1000;

  while (Date.now() - start < timeoutMs) {
    if (!isAgentRunning(threadId)) return;
    await new Promise((resolve) => setTimeout(resolve, pollInterval));
  }

  throw new Error(`Agent timed out after ${timeoutMs}ms`);
}
