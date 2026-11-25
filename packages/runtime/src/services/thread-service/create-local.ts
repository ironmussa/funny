/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: thread:created
 */
/** Local-mode threads and threads reusing an existing worktree. */

import {
  findWorktreeForBranch,
  getCurrentBranch,
  git,
  isRegisteredWorktreePath,
} from '@funny/core/git';

import { log } from '../../lib/logger.js';
import { startAgent } from '../agent-runner-control.js';
import { recordCheckoutSwitch } from '../checkout-activity.js';
import { threadEventBus } from '../thread-event-bus.js';
import * as tm from '../thread-manager.js';
import {
  augmentAllowedToolsWithRules,
  augmentPromptReferences,
  baseProjectThreadRow,
  checkpointingFor,
  type ProjectThreadContext,
} from './create-context.js';
import { startRemoteContainerThread } from './create-remote-container.js';
import { ThreadServiceError, withStagedUploads } from './helpers.js';

interface LocalPlacement {
  worktreePath: string | undefined;
  threadBranch: string | undefined;
  needsBranchCheckout: boolean;
  /** The checkout's branch before the thread was placed. */
  currentBranch?: string;
}

/**
 * Security CR-4: client-supplied worktreePath becomes the cwd for
 * browse/file-index/text-search/agent-spawn. An attacker who supplies an
 * arbitrary path — `/etc`, another user's HOME, etc. — would otherwise pivot
 * downstream file/command ops into that scope. Accept only paths registered
 * by Git as worktrees for this project, including externally-created
 * worktrees outside `.funny-worktrees`.
 */
async function assertRegisteredWorktree(projectPath: string, worktreePath: string): Promise<void> {
  const registeredResult = await isRegisteredWorktreePath(projectPath, worktreePath);
  if (registeredResult.isErr()) {
    throw new ThreadServiceError(registeredResult.error.message, 400);
  }
  if (!registeredResult.value) {
    throw new ThreadServiceError('worktreePath is not registered for this project', 400);
  }
}

/**
 * Decide where a local / existing-worktree thread runs and on which branch.
 * When a different base branch is requested, prefer an existing worktree
 * already on it; otherwise flag that a checkout is needed.
 */
async function resolveLocalPlacement(ctx: ProjectThreadContext): Promise<LocalPlacement> {
  const { params, projectPath, resolvedBaseBranch } = ctx;
  let worktreePath: string | undefined;
  if (params.worktreePath) {
    await assertRegisteredWorktree(projectPath, params.worktreePath);
    worktreePath = params.worktreePath;
  }

  const branchResult = await getCurrentBranch(params.worktreePath || projectPath);
  if (branchResult.isErr()) {
    return { worktreePath, threadBranch: undefined, needsBranchCheckout: false };
  }
  const currentBranch = branchResult.value;
  if (!resolvedBaseBranch || resolvedBaseBranch === currentBranch) {
    return { worktreePath, threadBranch: currentBranch, needsBranchCheckout: false };
  }

  const existingWorktree = await findWorktreeForBranch(projectPath, resolvedBaseBranch);
  if (existingWorktree.isOk() && existingWorktree.value) {
    return {
      worktreePath: existingWorktree.value,
      threadBranch: resolvedBaseBranch,
      needsBranchCheckout: false,
    };
  }
  return {
    worktreePath,
    threadBranch: resolvedBaseBranch,
    needsBranchCheckout: true,
    currentBranch,
  };
}

/** Local mode with branch checkout (synchronous, no setting_up UI). */
async function checkoutBaseBranch(
  ctx: ProjectThreadContext,
  branch: string,
  checkoutCwd: string,
  fromBranch?: string,
): Promise<void> {
  const fetchResult = await git(['fetch', 'origin', branch], checkoutCwd);
  if (fetchResult.isErr()) {
    log.warn('Failed to fetch branch before checkout (non-fatal)', {
      namespace: 'thread-service',
      threadId: ctx.threadId,
      branch,
      error: fetchResult.error.message,
    });
  }

  const checkoutResult = await git(['checkout', branch], checkoutCwd);
  // Starting the thread switched the user's checkout (track-funny-actions).
  const switched = {
    userId: ctx.params.userId,
    projectId: ctx.projectId,
    threadId: ctx.threadId,
    fromBranch,
    toBranch: branch,
    stashed: false,
    reason: 'thread-created' as const,
    origin: 'implicit' as const,
  };
  if (checkoutResult.isErr()) {
    void recordCheckoutSwitch({
      ...switched,
      switched: false,
      error: checkoutResult.error.message,
    });
    throw new ThreadServiceError(
      `Failed to checkout branch "${branch}": ${checkoutResult.error.message}`,
      400,
    );
  }
  void recordCheckoutSwitch(switched);
}

export async function createLocalThread(baseCtx: ProjectThreadContext) {
  const { worktreePath, threadBranch, needsBranchCheckout, currentBranch } =
    await resolveLocalPlacement(baseCtx);
  const cwd = worktreePath ?? baseCtx.projectPath;

  if (needsBranchCheckout) {
    // Falls through to the normal path below (status: 'pending')
    await checkoutBaseBranch(baseCtx, baseCtx.resolvedBaseBranch!, cwd, currentBranch);
  }

  const ctx = {
    ...baseCtx,
    params: await withStagedUploads(baseCtx.params, baseCtx.threadId, cwd),
  };
  const { params, defaults, threadId, resolvedBaseBranch } = ctx;

  const thread = {
    ...baseProjectThreadRow(ctx),
    mode: params.mode,
    status: 'pending' as const,
    runtime: params.runtime || ('local' as const),
    branch: threadBranch,
    baseBranch: resolvedBaseBranch || (params.mode === 'local' ? threadBranch : undefined),
    worktreePath,
    fileCheckpointingEnabled: checkpointingFor(defaults.provider),
  };

  await tm.createThread(thread);

  threadEventBus.emit('thread:created', {
    threadId,
    projectId: ctx.projectId,
    userId: params.userId,
    cwd,
    worktreePath: worktreePath ?? null,
    stage: 'in_progress' as const,
    status: 'pending',
  });

  // Augment prompt with file/symbol contents if references were provided
  const augmentedPrompt = await augmentPromptReferences(params, cwd);

  // ── Remote runtime: launch container instead of local agent ──
  if (params.runtime === 'remote') {
    await startRemoteContainerThread(ctx, threadBranch, augmentedPrompt);
    return thread;
  }

  // Start agent (a failed start throws — caller handles HTTP error response)
  const allowedToolsForRun = await augmentAllowedToolsWithRules(
    params.userId,
    cwd,
    params.allowedTools,
  );
  const started = await startAgent(
    threadId,
    augmentedPrompt,
    cwd,
    defaults.model,
    defaults.permissionMode,
    params.images,
    params.disallowedTools,
    allowedToolsForRun,
    defaults.provider,
    undefined,
    undefined,
    params.effort,
  );
  if (started.isErr()) throw new Error(started.error.message);

  return thread;
}
