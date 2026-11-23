/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: thread:stage-changed
 */

import { findWorktreeForBranch, getCurrentBranch, git, isSafeGitRefArg } from '@funny/core/git';
import type {
  WSEvent,
  AgentProvider,
  AgentModel,
  PermissionMode,
  ThreadStatus,
} from '@funny/shared';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_PERMISSION_MODE } from '@funny/shared/models';
import { isThreadStatus } from '@funny/shared/thread-machine';
import { ResultAsync } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { hydrateReferencedFiles } from '../../utils/file-mentions.js';
import { startAgent, stopAgent, isAgentRunning } from '../agent-runner-control.js';
import type { IProjectRepository } from '../server-interfaces.js';
import { getServices } from '../service-registry.js';
import { threadEventBus } from '../thread-event-bus.js';
import * as tm from '../thread-manager.js';
import { wsBroker } from '../ws-broker.js';
import { ThreadServiceError, emitAgentFailed, emitThreadUpdated, slugifyTitle } from './helpers.js';
import { copyThreadUploads } from './staged-uploads.js';
import { prepareWorktree } from './worktree-preparation.js';

// ── Update Thread (stage transitions, archive) ──────────────────

export interface UpdateThreadParams {
  threadId: string;
  userId: string;
  title?: string;
  archived?: boolean;
  pinned?: boolean;
  stage?: string;
}

export function updateThread(
  params: UpdateThreadParams,
): ResultAsync<Awaited<ReturnType<typeof updateThreadImpl>>, ThreadServiceError> {
  return ResultAsync.fromPromise(updateThreadImpl(params), (err) =>
    err instanceof ThreadServiceError ? err : new ThreadServiceError(String(err), 500),
  );
}

async function updateThreadImpl(params: UpdateThreadParams) {
  const thread = await tm.getThread(params.threadId);
  if (!thread) throw new ThreadServiceError('Thread not found', 404);

  const updates: Record<string, any> = {};
  if (params.title !== undefined) {
    updates.title = params.title;
  }
  if (params.archived !== undefined) {
    updates.archived = params.archived ? 1 : 0;
  }
  if (params.pinned !== undefined) {
    updates.pinned = params.pinned ? 1 : 0;
  }
  if (params.stage !== undefined) {
    updates.stage = params.stage;
  }

  const fromStage = thread.stage;

  // Archiving removes a worktree thread's workspace on the server's request
  // (track-funny-actions, design D8: `DELETE /api/worktrees` from
  // `server/services/thread-workspace-cleanup.ts`), not here.

  if (Object.keys(updates).length > 0) {
    await tm.updateThread(params.threadId, updates);
  }

  // Emit stage-changed events
  const project = await getServices().projects.getProject(thread.projectId);
  const eventPathResult = await getServices().projects.resolveProjectPath(
    thread.projectId,
    thread.userId,
  );
  const eventCwd =
    thread.worktreePath ?? (eventPathResult.isOk() ? eventPathResult.value : (project?.path ?? ''));
  const eventCtx = {
    threadId: params.threadId,
    projectId: thread.projectId,
    userId: thread.userId,
    worktreePath: thread.worktreePath ?? null,
    cwd: eventCwd,
  };
  if (params.archived) {
    threadEventBus.emit('thread:stage-changed', {
      ...eventCtx,
      fromStage: fromStage as any,
      toStage: 'archived',
    });
  } else if (params.stage && params.stage !== fromStage) {
    threadEventBus.emit('thread:stage-changed', {
      ...eventCtx,
      fromStage: fromStage as any,
      toStage: params.stage as any,
    });
  }

  // Auto-start agent when idle thread is moved to in_progress
  if (params.stage === 'in_progress' && thread.status === 'idle' && thread.initialPrompt) {
    if (project) {
      await autoStartIdleThread(params.threadId, thread, project);
    }
  }

  return await tm.getThread(params.threadId);
}

// ── Auto-start idle thread ──────────────────────────────────────

/**
 * The prompt a backlog thread starts with: its path-only references are
 * inlined now (resolved against the project checkout, where they were picked
 * and where staged uploads were adopted), and its uploads are copied into
 * `cwd` when the agent runs elsewhere (a worktree) so it can Read them.
 */
async function startPromptForIdleThread(
  threadId: string,
  prompt: string,
  projectPath: string,
  cwd: string,
): Promise<string> {
  if (cwd !== projectPath) {
    const copied = await copyThreadUploads(projectPath, cwd, threadId);
    if (copied.isErr()) {
      log.warn('Failed to copy uploads into worktree', {
        namespace: 'agent',
        threadId,
        error: copied.error.message,
      });
    }
  }
  return hydrateReferencedFiles(prompt, projectPath);
}

async function autoStartIdleThread(
  threadId: string,
  thread: NonNullable<Awaited<ReturnType<typeof tm.getThread>>>,
  project: NonNullable<Awaited<ReturnType<IProjectRepository['getProject']>>>,
): Promise<void> {
  // Resolve per-user path (owner uses project.path, member uses localPath)
  const pathResult = await getServices().projects.resolveProjectPath(project.id, thread.userId);
  if (pathResult.isErr()) {
    log.error('Cannot resolve project path for idle thread', {
      namespace: 'agent',
      threadId,
      error: pathResult.error.message,
    });
    await tm.updateThread(threadId, { status: 'failed', completedAt: new Date().toISOString() });
    emitAgentFailed(thread.userId, threadId);
    return;
  }
  const projectPath = pathResult.value;

  const needsWorktreeSetup = thread.mode === 'worktree' && !thread.worktreePath && thread.branch;

  if (needsWorktreeSetup) {
    // Deferred worktree setup: create worktree first, then start agent
    await tm.updateThread(threadId, { status: 'setting_up' });
    emitThreadUpdated(thread.userId, threadId, { status: 'setting_up', stage: 'in_progress' });

    // Background: create worktree, run post-create, then start agent
    void (async () => {
      try {
        const wtResult = await prepareWorktree({
          projectPath,
          branchName: thread.branch!,
          baseBranch: thread.baseBranch || undefined,
          userId: thread.userId,
          threadId,
          flow: 'idle-start',
          projectId: thread.projectId,
        });
        if (wtResult.isErr()) {
          await tm.updateThread(threadId, { status: 'failed' });
          emitThreadUpdated(thread.userId, threadId, { status: 'failed' });
          return;
        }
        const wtPath = wtResult.value;

        // Update thread with worktree info
        await tm.updateThread(threadId, { worktreePath: wtPath, status: 'pending' });
        wsBroker.emitToUser(thread.userId, {
          type: 'worktree:setup_complete',
          threadId,
          data: { branch: thread.branch, worktreePath: wtPath },
        } as WSEvent);
        emitThreadUpdated(thread.userId, threadId, {
          status: 'pending',
          branch: thread.branch,
          worktreePath: wtPath,
        });

        // Start agent
        const { messages: draftMessages } = await tm.getThreadMessages({ threadId, limit: 1 });
        const draftMsg = draftMessages[0];
        const draftImages = draftMsg?.images ? JSON.parse(draftMsg.images as string) : undefined;
        const started = await startAgent(
          threadId,
          await startPromptForIdleThread(threadId, thread.initialPrompt!, projectPath, wtPath),
          wtPath,
          (thread.model || project.defaultModel || DEFAULT_MODEL) as AgentModel,
          (thread.permissionMode || DEFAULT_PERMISSION_MODE) as PermissionMode,
          draftImages,
          undefined,
          undefined,
          (thread.provider || project.defaultProvider || DEFAULT_PROVIDER) as AgentProvider,
          undefined,
          !!draftMsg,
        );
        if (started.isErr()) throw new Error(started.error.message);
      } catch (err) {
        log.error('Failed to setup worktree and start agent', {
          namespace: 'agent',
          threadId,
          error: err,
        });
        await tm.updateThread(threadId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
        });
        emitAgentFailed(thread.userId, threadId);
      }
    })();
  } else {
    // Worktree already exists or local mode: start agent directly
    let cwd = thread.worktreePath || projectPath;

    // Check if local mode needs branch checkout (synchronous, no setting_up UI).
    // isSafeGitRefArg: baseBranch is user-supplied and passed positionally to
    // fetch/checkout below, so it must never be parseable as an option.
    const needsCheckout =
      !thread.worktreePath &&
      isSafeGitRefArg(thread.baseBranch) &&
      thread.branch &&
      thread.baseBranch !== thread.branch;

    if (needsCheckout) {
      const existingWorktree = await findWorktreeForBranch(projectPath, thread.baseBranch!);
      if (existingWorktree.isOk() && existingWorktree.value) {
        cwd = existingWorktree.value;
        await tm.updateThread(threadId, { branch: thread.baseBranch, worktreePath: cwd });
        emitThreadUpdated(thread.userId, threadId, {
          branch: thread.baseBranch,
          worktreePath: cwd,
        });
      } else {
        const fetchResult = await git(['fetch', 'origin', thread.baseBranch!], projectPath);
        if (fetchResult.isErr()) {
          log.warn('Failed to fetch branch for idle thread checkout (non-fatal)', {
            namespace: 'agent',
            threadId,
            error: fetchResult.error.message,
          });
        }
        const checkoutResult = await git(['checkout', thread.baseBranch!], projectPath);
        if (checkoutResult.isErr()) {
          log.error('Failed to checkout branch for idle thread', {
            namespace: 'agent',
            threadId,
            error: checkoutResult.error.message,
          });
          await tm.updateThread(threadId, {
            status: 'failed',
            completedAt: new Date().toISOString(),
          });
          emitAgentFailed(thread.userId, threadId);
          return;
        }
        await tm.updateThread(threadId, { branch: thread.baseBranch });
        // Fall through to normal agent start below
      }
    }

    const { messages: draftMessages } = await tm.getThreadMessages({ threadId, limit: 1 });
    const draftMsg = draftMessages[0];
    const draftImages = draftMsg?.images ? JSON.parse(draftMsg.images as string) : undefined;
    const startPrompt = await startPromptForIdleThread(
      threadId,
      thread.initialPrompt!,
      projectPath,
      cwd,
    );
    void startAgent(
      threadId,
      startPrompt,
      cwd,
      (thread.model || project.defaultModel || DEFAULT_MODEL) as AgentModel,
      (thread.permissionMode || DEFAULT_PERMISSION_MODE) as PermissionMode,
      draftImages,
      undefined,
      undefined,
      (thread.provider || project.defaultProvider || DEFAULT_PROVIDER) as AgentProvider,
      undefined,
      !!draftMsg,
    ).match(
      () => undefined,
      async (error) => {
        log.error('Failed to auto-start agent for idle thread', {
          namespace: 'agent',
          threadId,
          error: error.message,
        });
        await tm.updateThread(threadId, {
          status: 'failed',
          completedAt: new Date().toISOString(),
        });
        emitAgentFailed(thread.userId, threadId);
      },
    );
  }
}

// ── Convert Local Thread to Worktree ────────────────────────

export function convertToWorktree(
  threadId: string,
  userId: string,
  baseBranch?: string,
): ResultAsync<void, ThreadServiceError> {
  return ResultAsync.fromPromise(convertToWorktreeImpl(threadId, userId, baseBranch), (err) =>
    err instanceof ThreadServiceError ? err : new ThreadServiceError(String(err), 500),
  );
}

/**
 * The status a thread returns to once its worktree is ready. Converting starts
 * no agent, so the thread goes back to where it was instead of `pending`,
 * which the UI shows as a launch in progress. An agent the conversion stopped
 * leaves the thread `stopped`.
 */
function statusAfterConvert(
  prior: string | null | undefined,
  agentWasRunning: boolean,
): ThreadStatus {
  if (!prior || !isThreadStatus(prior)) return agentWasRunning ? 'stopped' : 'pending';
  if (agentWasRunning || prior === 'running' || prior === 'waiting') return 'stopped';
  if (prior === 'setting_up') return 'pending';
  return prior;
}

async function convertToWorktreeImpl(
  threadId: string,
  userId: string,
  baseBranch?: string,
): Promise<void> {
  const thread = await tm.getThread(threadId);
  if (!thread) throw new ThreadServiceError('Thread not found', 404);
  if (thread.mode !== 'local') {
    throw new ThreadServiceError('Thread is already in worktree mode', 400);
  }
  if (thread.worktreePath) {
    throw new ThreadServiceError('Thread already has a worktree', 400);
  }

  const project = await getServices().projects.getProject(thread.projectId);
  if (!project) throw new ThreadServiceError('Project not found', 404);

  const pathResult = await getServices().projects.resolveProjectPath(thread.projectId, userId);
  if (pathResult.isErr()) throw new ThreadServiceError(pathResult.error.message, 400);
  const projectPath = pathResult.value;

  // Stop the agent if running
  const agentWasRunning = isAgentRunning(threadId);
  const settledStatus = statusAfterConvert(thread.status, agentWasRunning);
  if (agentWasRunning) {
    const stopped = await stopAgent(threadId);
    if (stopped.isErr()) {
      log.warn('Failed to stop agent during convert-to-worktree', {
        namespace: 'thread-service',
        threadId,
        error: stopped.error.message,
      });
    }
  }

  // Detect current branch for baseBranch
  const currentBranchResult = await getCurrentBranch(projectPath);
  const resolvedBaseBranch =
    baseBranch?.trim() || (currentBranchResult.isOk() ? currentBranchResult.value : undefined);

  // Generate branch name using the same pattern as createAndStartThread
  const slug = slugifyTitle(thread.title || 'thread');
  const projectSlug = slugifyTitle(project.name);
  const branchName = `${projectSlug}/${slug}-${threadId.slice(0, 6)}`;

  // Set status to setting_up
  await tm.updateThread(threadId, { status: 'setting_up' });
  emitThreadUpdated(userId, threadId, { status: 'setting_up' });

  // Background: create worktree, run post-create commands, update thread
  void (async () => {
    try {
      const wtResult = await prepareWorktree({
        projectPath,
        branchName,
        baseBranch: resolvedBaseBranch,
        userId,
        threadId,
        flow: 'convert',
        projectId: thread.projectId,
      });
      if (wtResult.isErr()) {
        await tm.updateThread(threadId, { status: 'failed' });
        emitThreadUpdated(userId, threadId, { status: 'failed' });
        return;
      }
      const wtPath = wtResult.value;

      // Update thread: convert to worktree mode
      // Clear sessionId and flag context recovery so the next message
      // rebuilds the full conversation history (the old session was in
      // the project dir and is no longer valid in the worktree).
      await tm.updateThread(threadId, {
        mode: 'worktree',
        branch: branchName,
        baseBranch: resolvedBaseBranch,
        worktreePath: wtPath,
        status: settledStatus,
        sessionId: null,
        contextRecoveryReason: 'worktree-convert',
      });
      wsBroker.emitToUser(userId, {
        type: 'worktree:setup_complete',
        threadId,
        data: { branch: branchName, worktreePath: wtPath },
      } as WSEvent);
      emitThreadUpdated(userId, threadId, {
        mode: 'worktree',
        branch: branchName,
        baseBranch: resolvedBaseBranch,
        worktreePath: wtPath,
        status: settledStatus,
      });
    } catch (err) {
      log.error('Background convert-to-worktree failed', { threadId, error: String(err) });
      await tm.updateThread(threadId, { status: 'failed' });
      emitThreadUpdated(userId, threadId, { status: 'failed' });
    }
  })();
}
