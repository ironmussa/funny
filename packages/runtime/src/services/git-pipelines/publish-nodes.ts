/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: core
 * @domain type: pipeline-node
 * @domain layer: application
 *
 * Push, pull request and merge nodes. Each runs as one tracked progress step.
 */
import { push as gitPush, invalidateStatusCache, gitRead } from '@funny/core/git';
import { node, type PipelineNode } from '@funny/pipelines';

import {
  pushChanges as gitServicePush,
  merge as gitServiceMerge,
  createPullRequest as gitServiceCreatePR,
  resolveIdentity,
} from '../git-service.js';
import * as tm from '../thread-manager.js';
import type { GitPipelineContext } from './context.js';
import { trackStep, unwrapGit } from './node-helpers.js';

async function pushNode(ctx: GitPipelineContext): Promise<GitPipelineContext> {
  await trackStep(ctx, 'push', 'Push failed', async () => {
    if (ctx.threadId) {
      unwrapGit(await gitServicePush(ctx.threadId, ctx.userId, ctx.cwd, ctx.workflowId));
    } else {
      const identity = await resolveIdentity(ctx.userId, ctx.projectId);
      unwrapGit(await gitPush(ctx.cwd, identity));
      invalidateStatusCache(ctx.cwd);
    }
  });
  return ctx;
}

/** Refuse a PR before calling GitHub when the branch has no commits ahead of its base. */
async function assertCommitsAheadOfBase(threadId: string, cwd: string): Promise<void> {
  const thread = await tm.getThread(threadId);
  const base = thread?.baseBranch;
  if (!base) return;
  const countResult = await gitRead(['rev-list', '--count', `${base}..HEAD`], {
    cwd,
    reject: false,
  });
  const ahead = parseInt(countResult.stdout.trim(), 10) || 0;
  if (ahead === 0) {
    throw new Error(`No commits ahead of ${base}. Push new commits before creating a PR.`);
  }
}

async function prNode(ctx: GitPipelineContext): Promise<GitPipelineContext> {
  await trackStep(ctx, 'pr', 'PR creation failed', async () => {
    if (!ctx.threadId) throw new Error('PR creation requires a thread');

    await assertCommitsAheadOfBase(ctx.threadId, ctx.cwd);

    const prUrl = unwrapGit(
      await gitServiceCreatePR({
        threadId: ctx.threadId,
        userId: ctx.userId,
        cwd: ctx.cwd,
        title: ctx.prTitle || ctx.message || '',
        body: ctx.prBody || '',
      }),
    );
    ctx.prUrl = prUrl || undefined;
    return { url: prUrl || undefined };
  });
  return ctx;
}

async function mergeNode(ctx: GitPipelineContext): Promise<GitPipelineContext> {
  await trackStep(ctx, 'merge', 'Merge failed', async () => {
    if (!ctx.threadId) throw new Error('Merge requires a thread');
    unwrapGit(
      await gitServiceMerge({
        threadId: ctx.threadId,
        userId: ctx.userId,
        targetBranch: ctx.targetBranch,
        cleanup: ctx.cleanup,
      }),
    );
  });
  return ctx;
}

export const pushNodes: PipelineNode<GitPipelineContext>[] = [node('push', pushNode)];
export const prNodes: PipelineNode<GitPipelineContext>[] = [node('pr', prNode)];
export const mergeNodes: PipelineNode<GitPipelineContext>[] = [node('merge', mergeNode)];
