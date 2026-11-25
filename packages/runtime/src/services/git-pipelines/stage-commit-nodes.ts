/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: core
 * @domain type: pipeline-node
 * @domain layer: application
 *
 * Stage and commit nodes: unstage → stage, then hooks (with auto-fix) → commit.
 */
import {
  stageFiles as gitStageFiles,
  unstageFiles as gitUnstageFiles,
  commit as gitCommit,
  runHookCommand,
  invalidateStatusCache,
  gitRead,
} from '@funny/core/git';
import { node, type PipelineNode } from '@funny/pipelines';

import {
  stage as gitServiceStage,
  unstage as gitServiceUnstage,
  commitChanges as gitServiceCommit,
  resolveIdentity,
} from '../git-service.js';
import { emitWorkflowEvent } from '../workflow-event-helpers.js';
import type { GitPipelineContext } from './context.js';
import { unwrapGit } from './node-helpers.js';
import { attemptPrecommitAutoFix, HookFailedError } from './precommit-autofix.js';

/** A hook of a `workflow:hooks` failure event. */
type FailedHookEventItem = {
  label: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  error?: string;
};

/** An absent error is left out of the event, as the JSON payload always did. */
function failedHookEventItem(
  hook: Omit<FailedHookEventItem, 'error'> & { error: string | undefined },
): FailedHookEventItem {
  const item: FailedHookEventItem = {
    label: hook.label,
    status: hook.status,
  };
  if (hook.error !== undefined) item.error = hook.error;
  return item;
}

// ── Stage nodes ──────────────────────────────────────────────

async function unstageNode(ctx: GitPipelineContext): Promise<GitPipelineContext> {
  ctx.setStep('unstage', { status: 'running' });

  if (ctx.threadId) {
    unwrapGit(
      await gitServiceUnstage(
        ctx.threadId,
        ctx.userId,
        ctx.cwd,
        ctx.filesToUnstage!,
        ctx.workflowId,
      ),
    );
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
    unwrapGit(
      await gitServiceStage(ctx.threadId, ctx.userId, ctx.cwd, ctx.filesToStage!, ctx.workflowId),
    );
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

      const hookResultR = await runHookCommand(ctx.cwd, ctx.hooks[i].command);
      const hookResult = hookResultR.isOk()
        ? hookResultR.value
        : { success: false, output: hookResultR.error.message };

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
            precommitFixerPrompt: ctx.precommitFixerPrompt,
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
            hooks: failedSubItems.map(failedHookEventItem),
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

  // While this workflow is active the pipeline-trigger-handler skips the
  // commit's git:committed event (isWorkflowActive), so no second review starts.
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
      unwrapGit(result);
    } else {
      const identity = await resolveIdentity(ctx.userId, ctx.projectId);
      const result = await gitCommit(ctx.cwd, ctx.message!, identity, isAmend, noVerify);
      unwrapGit(result);
      invalidateStatusCache(ctx.cwd);
    }
  } catch (e: any) {
    const errorMsg = e.stderr || e.message || 'Commit failed';
    ctx.setStep('commit', { status: 'failed', error: errorMsg });
    throw new Error(errorMsg, { cause: e });
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
