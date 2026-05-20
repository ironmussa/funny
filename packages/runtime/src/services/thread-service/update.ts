/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: thread:stage-changed, thread:deleted
 */

import { rmSync } from 'node:fs';

import {
  createWorktree,
  removeWorktree,
  removeBranch,
  getCurrentBranch,
  git,
} from '@funny/core/git';
import { setupWorktree } from '@funny/core/ports';
import type { WSEvent, AgentProvider, AgentModel, PermissionMode } from '@funny/shared';
import { DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_PERMISSION_MODE } from '@funny/shared/models';

import { log } from '../../lib/logger.js';
import { startAgent, stopAgent, isAgentRunning, cleanupThreadState } from '../agent-runner.js';
import { stopCommandsByCwd } from '../command-runner.js';
import { stopContainer } from '../podman-service.js';
import type { IProjectRepository } from '../server-interfaces.js';
import { getServices } from '../service-registry.js';
import { scratchPathFor } from '../thread-context.js';
import { threadEventBus } from '../thread-event-bus.js';
import * as tm from '../thread-manager.js';
import { wsBroker } from '../ws-broker.js';
import {
  ThreadServiceError,
  createSetupProgressEmitter,
  emitAgentFailed,
  emitThreadUpdated,
  slugifyTitle,
} from './helpers.js';

// ── Update Thread (stage transitions, archive) ──────────────────

export interface UpdateThreadParams {
  threadId: string;
  userId: string;
  title?: string;
  archived?: boolean;
  pinned?: boolean;
  stage?: string;
}

export async function updateThread(params: UpdateThreadParams) {
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

  // Cleanup worktree + branch when archiving
  if (
    params.archived &&
    thread.worktreePath &&
    thread.mode === 'worktree' &&
    thread.provider !== 'external'
  ) {
    const archivePathResult = await getServices().projects.resolveProjectPath(
      thread.projectId,
      thread.userId,
    );
    const archivePath = archivePathResult.isOk() ? archivePathResult.value : undefined;
    if (archivePath) {
      await stopCommandsByCwd(thread.worktreePath).catch(() => {});
      await removeWorktree(archivePath, thread.worktreePath).catch((e) => {
        log.warn('Failed to remove worktree', { namespace: 'cleanup', error: String(e) });
      });
      if (thread.branch) {
        await removeBranch(archivePath, thread.branch).catch((e) => {
          log.warn('Failed to remove branch', { namespace: 'cleanup', error: String(e) });
        });
      }
    }
    updates.worktreePath = null;
    updates.branch = null;
    await getServices().messageQueue.clearQueue(params.threadId);
    cleanupThreadState(params.threadId);
  }

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
    const emitSetupProgress = createSetupProgressEmitter(thread.userId, threadId);
    emitThreadUpdated(thread.userId, threadId, { status: 'setting_up', stage: 'in_progress' });

    // Background: create worktree, run post-create, then start agent
    void (async () => {
      try {
        const wtResult = await createWorktree(
          projectPath,
          thread.branch!,
          thread.baseBranch || undefined,
          emitSetupProgress,
        );
        if (wtResult.isErr()) {
          await tm.updateThread(threadId, { status: 'failed' });
          emitThreadUpdated(thread.userId, threadId, { status: 'failed' });
          return;
        }
        const wtPath = wtResult.value;

        const setupResult = await setupWorktree(projectPath, wtPath, emitSetupProgress);
        if (setupResult.isOk() && setupResult.value.postCreateErrors.length) {
          log.warn('Worktree postCreate errors', {
            threadId,
            errors: setupResult.value.postCreateErrors,
          });
        } else if (setupResult.isErr()) {
          log.warn('Failed to setup worktree', { threadId, error: setupResult.error.message });
        }

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
        await startAgent(
          threadId,
          thread.initialPrompt!,
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
    const cwd = thread.worktreePath || projectPath;

    // Check if local mode needs branch checkout (synchronous, no setting_up UI)
    const needsCheckout =
      !thread.worktreePath &&
      thread.baseBranch &&
      thread.branch &&
      thread.baseBranch !== thread.branch;

    if (needsCheckout) {
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

    const { messages: draftMessages } = await tm.getThreadMessages({ threadId, limit: 1 });
    const draftMsg = draftMessages[0];
    const draftImages = draftMsg?.images ? JSON.parse(draftMsg.images as string) : undefined;
    startAgent(
      threadId,
      thread.initialPrompt!,
      cwd,
      (thread.model || project.defaultModel || DEFAULT_MODEL) as AgentModel,
      (thread.permissionMode || DEFAULT_PERMISSION_MODE) as PermissionMode,
      draftImages,
      undefined,
      undefined,
      (thread.provider || project.defaultProvider || DEFAULT_PROVIDER) as AgentProvider,
      undefined,
      !!draftMsg,
    ).catch(async (err) => {
      log.error('Failed to auto-start agent for idle thread', {
        namespace: 'agent',
        threadId,
        error: err,
      });
      await tm.updateThread(threadId, { status: 'failed', completedAt: new Date().toISOString() });
      emitAgentFailed(thread.userId, threadId);
    });
  }
}

// ── Delete Thread ───────────────────────────────────────────────

export async function deleteThread(threadId: string): Promise<void> {
  const thread = await tm.getThread(threadId);
  if (!thread) throw new ThreadServiceError('Thread not found', 404);

  threadEventBus.emit('thread:deleted', {
    threadId,
    projectId: thread.projectId ?? '',
    userId: thread.userId,
    worktreePath: thread.worktreePath ?? null,
  });

  if (isAgentRunning(threadId)) {
    try {
      await stopAgent(threadId);
    } catch (err) {
      log.error('Failed to stop agent', { namespace: 'agent', threadId, error: err });
    }
  }

  // Only remove worktree/branch for worktree-mode threads
  if (thread.worktreePath && thread.mode === 'worktree' && thread.provider !== 'external') {
    await stopCommandsByCwd(thread.worktreePath).catch(() => {});

    const deletePathResult = await getServices().projects.resolveProjectPath(
      thread.projectId,
      thread.userId,
    );
    const deletePath = deletePathResult.isOk() ? deletePathResult.value : undefined;
    if (deletePath) {
      await removeWorktree(deletePath, thread.worktreePath).catch((e) => {
        log.warn('Failed to remove worktree', { namespace: 'cleanup', error: String(e) });
      });
      if (thread.branch) {
        await removeBranch(deletePath, thread.branch).catch((e) => {
          log.warn('Failed to remove branch', { namespace: 'cleanup', error: String(e) });
        });
      }
    }
  }

  // Scratch threads have a per-thread sandbox at ~/.funny/scratch/<userId>/<threadId>/.
  // Remove it on delete. Tolerate missing dir (never spawned an agent).
  if (thread.isScratch) {
    const scratchPath = scratchPathFor(thread.userId, threadId);
    try {
      rmSync(scratchPath, { recursive: true, force: true });
      log.info('Removed scratch directory', {
        namespace: 'scratch-threads',
        threadId,
        userId: thread.userId,
        scratchPath,
      });
    } catch (e) {
      log.warn('Failed to remove scratch directory', {
        namespace: 'scratch-threads',
        threadId,
        scratchPath,
        error: String(e),
      });
    }
  }

  // Stop container for remote threads (best-effort)
  if (thread.containerName && thread.runtime === 'remote') {
    const project = await getServices().projects.getProject(thread.projectId);
    if (project?.launcherUrl) {
      stopContainer({ containerName: thread.containerName, launcherUrl: project.launcherUrl })
        .then(() => {})
        .catch((e) =>
          log.warn('Failed to stop container', { namespace: 'podman', error: String(e) }),
        );
    }
  }

  await getServices().messageQueue.clearQueue(threadId);
  cleanupThreadState(threadId);
  await tm.deleteThread(threadId);
}

// ── Convert Local Thread to Worktree ────────────────────────

export async function convertToWorktree(
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
  if (isAgentRunning(threadId)) {
    try {
      await stopAgent(threadId);
    } catch (err) {
      log.warn('Failed to stop agent during convert-to-worktree', {
        namespace: 'thread-service',
        threadId,
        error: String(err),
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

  const emitSetupProgress = createSetupProgressEmitter(userId, threadId);

  // Background: create worktree, run post-create commands, update thread
  void (async () => {
    try {
      const wtResult = await createWorktree(
        projectPath,
        branchName,
        resolvedBaseBranch,
        emitSetupProgress,
      );
      if (wtResult.isErr()) {
        await tm.updateThread(threadId, { status: 'failed' });
        emitThreadUpdated(userId, threadId, { status: 'failed' });
        return;
      }
      const wtPath = wtResult.value;

      try {
        const setup = await setupWorktree(projectPath, wtPath, emitSetupProgress);
        if (setup.postCreateErrors.length) {
          log.warn('Worktree postCreate errors during convert', {
            threadId,
            errors: setup.postCreateErrors,
          });
        }
      } catch (err) {
        log.warn('Failed to setup worktree during convert', { threadId, error: String(err) });
      }

      // Update thread: convert to worktree mode
      // Clear sessionId and flag context recovery so the next message
      // rebuilds the full conversation history (the old session was in
      // the project dir and is no longer valid in the worktree).
      await tm.updateThread(threadId, {
        mode: 'worktree',
        branch: branchName,
        baseBranch: resolvedBaseBranch,
        worktreePath: wtPath,
        status: 'pending',
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
        status: 'pending',
      });
    } catch (err) {
      log.error('Background convert-to-worktree failed', { threadId, error: String(err) });
      await tm.updateThread(threadId, { status: 'failed' });
      emitThreadUpdated(userId, threadId, { status: 'failed' });
    }
  })();
}
