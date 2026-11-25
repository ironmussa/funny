/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: thread:created
 */
/** New-worktree threads: created in `setting_up`, the worktree and agent start in the background. */

import { getCurrentBranch } from '@funny/core/git';
import type { WSEvent } from '@funny/shared';

import { log } from '../../lib/logger.js';
import { stripInlineReferencedContent } from '../../utils/file-mentions.js';
import { startAgent } from '../agent-runner-control.js';
import { threadEventBus } from '../thread-event-bus.js';
import * as tm from '../thread-manager.js';
import { cleanupWorkspace } from '../workspace-cleanup.js';
import { wsBroker } from '../ws-broker.js';
import {
  augmentAllowedToolsWithRules,
  augmentPromptReferences,
  baseProjectThreadRow,
  checkpointingFor,
  markThreadFailed,
  type ProjectThreadContext,
} from './create-context.js';
import {
  emitThreadUpdated,
  slugifyTitle,
  ThreadServiceError,
  stripReferencedFilesBlock,
  withStagedUploads,
} from './helpers.js';
import { copyThreadUploads } from './staged-uploads.js';
import { worktreeBranchName, type WorktreeBranch } from './worktree-branch.js';
import { prepareWorktree } from './worktree-preparation.js';

/**
 * The branch a new worktree starts from. Without an explicit base the worktree
 * is created from the project checkout's HEAD, so record that branch: the git
 * status counts commits as `<base>..HEAD` while the branch has no upstream, and
 * a missing base made a pushless worktree thread show no commits (sidebar,
 * review pane) however many it had.
 */
async function worktreeBaseBranch(ctx: ProjectThreadContext): Promise<string | undefined> {
  if (ctx.resolvedBaseBranch) return ctx.resolvedBaseBranch;
  const current = await getCurrentBranch(ctx.projectPath);
  if (current.isErr()) return undefined;
  const branch = current.value.trim();
  return branch && branch !== 'HEAD' ? branch : undefined;
}

/**
 * Create the thread row in `setting_up`, persist the first message and kick
 * off worktree creation + agent start in the background.
 */
export async function createNewWorktreeThread(baseCtx: ProjectThreadContext) {
  // Adopted into the project checkout (file references are resolved against
  // it); copied into the worktree once it exists, before the agent starts.
  const ctx = {
    ...baseCtx,
    resolvedBaseBranch: await worktreeBaseBranch(baseCtx),
    params: await withStagedUploads(baseCtx.params, baseCtx.threadId, baseCtx.projectPath),
  };
  const { params, defaults, threadId, projectPath } = ctx;
  // Titles may carry the attachments block (badge) — never slug the XML.
  const slug = slugifyTitle(stripReferencedFilesBlock(ctx.titleSource));
  const projectSlug = slugifyTitle(ctx.project.name);
  const worktreeBranch = await worktreeBranchName(
    projectPath,
    params.branch,
    `${projectSlug}/${slug}-${threadId.slice(0, 6)}`,
  );
  if (params.requireBranch && params.branch && worktreeBranch.name !== params.branch.trim()) {
    throw new ThreadServiceError(
      worktreeBranch.heldBy
        ? `The branch "${params.branch}" is checked out in another worktree (${worktreeBranch.heldBy}): remove that worktree, then try again.`
        : `The branch "${params.branch}" could not be checked out: try again.`,
      409,
    );
  }
  const branchName = worktreeBranch.name;

  const thread = {
    ...baseProjectThreadRow(ctx),
    mode: params.mode,
    runtime: (params.runtime || 'local') as 'local' | 'remote',
    status: 'setting_up' as const,
    branch: branchName,
    baseBranch: ctx.resolvedBaseBranch,
    worktreePath: undefined as string | undefined,
    fileCheckpointingEnabled: checkpointingFor(defaults.provider),
  };

  await tm.createThread(thread as any);

  if (params.prompt) {
    // The agent gets the fully augmented prompt (with file contents inlined)
    // when startAgent runs; what we persist for display is the path-only
    // metadata version. See stripInlineReferencedContent.
    const storedContent = await augmentPromptReferences(params, projectPath);
    await tm.insertMessage({
      threadId,
      role: 'user',
      content: stripInlineReferencedContent(storedContent),
      images: params.images?.length ? JSON.stringify(params.images) : null,
      model: params.model ?? null,
      permissionMode: params.permissionMode ?? null,
      effort: params.effort ?? null,
    });
  }

  threadEventBus.emit('thread:created', {
    threadId,
    projectId: ctx.projectId,
    userId: params.userId,
    cwd: projectPath,
    worktreePath: null,
    stage: 'in_progress' as const,
    status: 'setting_up',
  });

  // Background: create worktree, run post-create commands, start agent
  void setupWorktreeAndStartAgent(ctx, worktreeBranch);

  return thread;
}

async function setupWorktreeAndStartAgent(
  ctx: ProjectThreadContext,
  { name: branchName, reuse }: WorktreeBranch,
): Promise<void> {
  const { params, threadId, projectPath } = ctx;
  try {
    const wtResult = await prepareWorktree({
      projectPath,
      branchName,
      reuseExistingBranch: reuse,
      baseBranch: ctx.resolvedBaseBranch,
      // Only with a base the caller named: the checkout's current branch
      // (the default base) may not exist on the remote at all.
      baseFromRemote: Boolean(params.baseFromRemote && params.baseBranch?.trim()),
      userId: params.userId,
      threadId,
      flow: 'create',
      projectId: ctx.projectId,
    });
    if (wtResult.isErr()) {
      await markThreadFailed(params.userId, threadId);
      return;
    }
    const wtPath = wtResult.value;

    // The worktree path is only saved by markWorktreeReady, so a thread deleted
    // while its worktree was being prepared left the worktree and branch behind.
    if (!(await tm.getThread(threadId))) {
      await removeOrphanWorktree(ctx, wtPath, branchName, reuse);
      return;
    }

    await markWorktreeReady(params.userId, threadId, branchName, wtPath);
    await startAgentInNewWorktree(ctx, wtPath);
  } catch (err) {
    log.error('Background worktree setup failed', { threadId, error: String(err) });
    await markThreadFailed(params.userId, threadId);
  }
}

/**
 * Remove the worktree (and the branch, unless it existed before this thread)
 * of a thread that was deleted while its worktree was being prepared.
 * A reused branch is kept: it holds an earlier attempt's work.
 */
async function removeOrphanWorktree(
  ctx: ProjectThreadContext,
  wtPath: string,
  branchName: string,
  reusedBranch: boolean,
): Promise<void> {
  const { threadId, projectPath } = ctx;
  log.info('Thread deleted during worktree setup; removing its worktree', {
    namespace: 'cleanup',
    threadId,
    worktreePath: wtPath,
  });
  // Recorded as a `setup-undone` cleanup (services/workspace-cleanup.ts).
  await cleanupWorkspace({
    userId: ctx.params.userId,
    projectId: ctx.projectId,
    projectPath,
    threadId,
    worktreePath: wtPath,
    branch: branchName,
    deleteBranch: !reusedBranch,
    reason: 'setup-undone',
  }).match(
    () => undefined,
    (e) => log.warn('Failed to undo worktree setup', { namespace: 'cleanup', error: e.message }),
  );
}

/** Record the worktree on the thread, transition it to pending and notify the user. */
async function markWorktreeReady(
  userId: string,
  threadId: string,
  branch: string,
  worktreePath: string,
): Promise<void> {
  await tm.updateThread(threadId, { worktreePath, status: 'pending' });
  wsBroker.emitToUser(userId, {
    type: 'worktree:setup_complete',
    threadId,
    data: { branch, worktreePath },
  } as WSEvent);
  emitThreadUpdated(userId, threadId, { status: 'pending', branch, worktreePath });
}

async function startAgentInNewWorktree(ctx: ProjectThreadContext, wtPath: string): Promise<void> {
  const { params, defaults, threadId } = ctx;
  // Use projectPath (not wtPath) because file references were selected from
  // the main repo; untracked/gitignored files won't exist in the freshly
  // created worktree.
  const augmentedPrompt = await augmentPromptReferences(params, ctx.projectPath);
  // Uploads live under the gitignored `.funny/`, so the new worktree does not
  // have them — copy them so the agent can Read the referenced paths.
  const copied = await copyThreadUploads(ctx.projectPath, wtPath, threadId);
  if (copied.isErr()) {
    log.warn('Failed to copy uploads into worktree', { threadId, error: copied.error.message });
  }
  try {
    const allowedToolsForRun = await augmentAllowedToolsWithRules(
      params.userId,
      wtPath,
      params.allowedTools,
    );
    const started = await startAgent(
      threadId,
      augmentedPrompt,
      wtPath,
      defaults.model,
      defaults.permissionMode,
      params.images,
      params.disallowedTools,
      allowedToolsForRun,
      defaults.provider,
      undefined,
      true, // skipMessageInsert — already inserted at thread creation
      params.effort,
    );
    if (started.isErr()) throw new Error(started.error.message);
  } catch (err: any) {
    log.error('Failed to start agent after worktree setup', { threadId, error: err });
    await markThreadFailed(params.userId, threadId);
  }
}
