/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: git:staged, git:unstaged, git:reverted, git:committed, git:pushed, git:pulled, git:merged, git:stashed, git:stash-popped, git:reset-soft
 * @domain depends: GitCore, ThreadEventBus, ProfileService, WSBroker
 */

import {
  stageFiles as gitStage,
  unstageFiles as gitUnstage,
  revertFiles as gitRevert,
  commit as gitCommit,
  push as gitPush,
  pull as gitPull,
  mergeBranch as gitMerge,
  stash as gitStash,
  stashPop as gitStashPop,
  resetSoft as gitResetSoft,
  createPR as gitCreatePR,
  git,
  invalidateStatusCache,
  sanitizePath,
  removeWorktree,
  removeBranch,
  type GitIdentityOptions,
} from '@funny/core/git';

import { getAuthMode } from '../lib/auth-mode.js';
import { log } from '../lib/logger.js';
import { getGitIdentity, getGithubToken } from './profile-service.js';
import * as pm from './project-manager.js';
import { threadEventBus } from './thread-event-bus.js';
import { saveThreadEvent } from './thread-event-service.js';
import * as tm from './thread-manager.js';
import { wsBroker } from './ws-broker.js';

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Resolve per-user git identity.
 * In local mode, uses the '__local__' profile for GitHub token support.
 * In multi-user mode, uses the authenticated user's profile.
 */
export function resolveIdentity(userId: string): GitIdentityOptions | undefined {
  const effectiveUserId =
    getAuthMode() === 'local' || userId === '__local__' ? '__local__' : userId;
  const author = getGitIdentity(effectiveUserId) ?? undefined;
  const githubToken = getGithubToken(effectiveUserId) ?? undefined;
  if (!author && !githubToken) return undefined;
  return { author, githubToken };
}

/** Validate that all file paths stay within the working directory. */
export function validateFilePaths(cwd: string, paths: string[]): string | null {
  for (const p of paths) {
    const result = sanitizePath(cwd, p);
    if (result.isErr()) return `Invalid path: ${p}`;
  }
  return null;
}

function getProjectId(threadId: string): string {
  return tm.getThread(threadId)?.projectId ?? '';
}

// ── Thread-scoped git operations ────────────────────────────────

export async function stage(
  threadId: string,
  userId: string,
  cwd: string,
  paths: string[],
): Promise<void> {
  const result = await gitStage(cwd, paths);
  if (result.isErr()) throw result.error;

  threadEventBus.emit('git:staged', {
    threadId,
    userId,
    projectId: getProjectId(threadId),
    paths,
    cwd,
  });

  invalidateStatusCache(cwd);
}

export async function unstage(
  threadId: string,
  userId: string,
  cwd: string,
  paths: string[],
): Promise<void> {
  const result = await gitUnstage(cwd, paths);
  if (result.isErr()) throw result.error;

  threadEventBus.emit('git:unstaged', {
    threadId,
    userId,
    projectId: getProjectId(threadId),
    paths,
    cwd,
  });

  invalidateStatusCache(cwd);
}

export async function revert(
  threadId: string,
  userId: string,
  cwd: string,
  paths: string[],
): Promise<void> {
  const result = await gitRevert(cwd, paths);
  if (result.isErr()) throw result.error;

  threadEventBus.emit('git:reverted', {
    threadId,
    userId,
    projectId: getProjectId(threadId),
    paths,
    cwd,
  });

  invalidateStatusCache(cwd);
}

export async function commitChanges(
  threadId: string,
  userId: string,
  cwd: string,
  message: string,
  amend?: boolean,
  noVerify?: boolean,
): Promise<string> {
  const identity = resolveIdentity(userId);
  const result = await gitCommit(cwd, message, identity, amend, noVerify);
  if (result.isErr()) throw result.error;

  threadEventBus.emit('git:committed', {
    threadId,
    userId,
    projectId: getProjectId(threadId),
    message,
    amend,
    cwd,
  });

  invalidateStatusCache(cwd);
  return result.value;
}

export async function pushChanges(threadId: string, userId: string, cwd: string): Promise<string> {
  const identity = resolveIdentity(userId);
  const result = await gitPush(cwd, identity);
  if (result.isErr()) throw result.error;

  threadEventBus.emit('git:pushed', {
    threadId,
    userId,
    projectId: getProjectId(threadId),
    cwd,
  });

  invalidateStatusCache(cwd);
  return result.value;
}

export async function pullChanges(threadId: string, userId: string, cwd: string): Promise<string> {
  const identity = resolveIdentity(userId);
  const result = await gitPull(cwd, identity);
  if (result.isErr()) throw result.error;

  threadEventBus.emit('git:pulled', {
    threadId,
    userId,
    projectId: getProjectId(threadId),
    cwd,
    output: result.value,
  });

  invalidateStatusCache(cwd);
  return result.value;
}

export async function stashChanges(threadId: string, userId: string, cwd: string): Promise<string> {
  const result = await gitStash(cwd);
  if (result.isErr()) throw result.error;

  threadEventBus.emit('git:stashed', {
    threadId,
    userId,
    projectId: getProjectId(threadId),
    cwd,
    output: result.value,
  });

  invalidateStatusCache(cwd);
  return result.value;
}

export async function popStash(threadId: string, userId: string, cwd: string): Promise<string> {
  const result = await gitStashPop(cwd);
  if (result.isErr()) throw result.error;

  threadEventBus.emit('git:stash-popped', {
    threadId,
    userId,
    projectId: getProjectId(threadId),
    cwd,
    output: result.value,
  });

  invalidateStatusCache(cwd);
  return result.value;
}

export async function softReset(threadId: string, userId: string, cwd: string): Promise<string> {
  const result = await gitResetSoft(cwd);
  if (result.isErr()) throw result.error;

  threadEventBus.emit('git:reset-soft', {
    threadId,
    userId,
    projectId: getProjectId(threadId),
    cwd,
    output: result.value,
  });

  invalidateStatusCache(cwd);
  return result.value;
}

// ── Merge ───────────────────────────────────────────────────────

export interface MergeParams {
  threadId: string;
  userId: string;
  targetBranch?: string;
  push?: boolean;
  cleanup?: boolean;
}

export async function merge(params: MergeParams): Promise<string> {
  const thread = tm.getThread(params.threadId);
  if (!thread || thread.mode !== 'worktree' || !thread.branch) {
    throw new Error('Merge is only available for worktree threads');
  }

  const project = pm.getProject(thread.projectId);
  if (!project) throw new Error('Project not found');

  const targetBranch = params.targetBranch || thread.baseBranch;
  if (!targetBranch) {
    throw new Error('No target branch specified and no baseBranch set on thread');
  }

  const identity = resolveIdentity(params.userId);
  const mergeResult = await gitMerge(
    project.path,
    thread.branch,
    targetBranch,
    identity,
    thread.worktreePath ?? undefined,
  );
  if (mergeResult.isErr()) throw mergeResult.error;

  threadEventBus.emit('git:merged', {
    threadId: params.threadId,
    userId: params.userId,
    projectId: thread.projectId,
    sourceBranch: thread.branch,
    targetBranch,
    output: mergeResult.value,
  });

  if (params.push) {
    const env = identity?.githubToken ? { GH_TOKEN: identity.githubToken } : undefined;
    const pushResult = await git(['push', 'origin', targetBranch], project.path, env);
    if (pushResult.isErr()) {
      throw new Error(`Merge succeeded but push failed: ${pushResult.error.message}`);
    }
  }

  if (params.cleanup && thread.worktreePath) {
    // removeWorktree has a fallback (fs.rm + prune). If even that fails,
    // we still proceed — the merge succeeded, so we update the DB and let
    // the orphaned directory be cleaned up manually or on next prune.
    await removeWorktree(project.path, thread.worktreePath).catch((e) =>
      log.warn('Worktree directory could not be removed (will be orphaned)', {
        namespace: 'git',
        worktreePath: thread.worktreePath,
        error: String(e),
      }),
    );

    await removeBranch(project.path, thread.branch).catch((e) =>
      log.warn('Failed to remove branch after merge', { namespace: 'git', error: String(e) }),
    );
    tm.updateThread(params.threadId, { worktreePath: null, branch: null, mode: 'local' });

    // Calculate actual unpushed commits on the target branch after merge
    let unpushedCommitCount = 0;
    try {
      const countResult = await git(
        ['rev-list', '--count', `origin/${targetBranch}..${targetBranch}`],
        project.path,
      );
      if (countResult.isOk()) {
        unpushedCommitCount = parseInt(countResult.value.trim(), 10) || 0;
      }
    } catch {
      // If remote tracking branch doesn't exist, leave as 0
    }

    // Broadcast merged status so Kanban cards update immediately
    wsBroker.emitToUser(params.userId, {
      type: 'git:status',
      threadId: params.threadId,
      data: {
        statuses: [
          {
            threadId: params.threadId,
            branchKey: `tid:${params.threadId}`,
            state: 'merged' as const,
            dirtyFileCount: 0,
            unpushedCommitCount,
            hasRemoteBranch: unpushedCommitCount > 0,
            isMergedIntoBase: true,
            linesAdded: 0,
            linesDeleted: 0,
          },
        ],
      },
    });
  }

  invalidateStatusCache(thread.worktreePath ?? project.path);
  return mergeResult.value;
}

// ── Create Pull Request ─────────────────────────────────────────

export interface CreatePRParams {
  threadId: string;
  userId: string;
  cwd: string;
  title: string;
  body: string;
}

export async function createPullRequest(params: CreatePRParams): Promise<string> {
  const thread = tm.getThread(params.threadId);
  const identity = resolveIdentity(params.userId);
  const result = await gitCreatePR(
    params.cwd,
    params.title,
    params.body,
    thread?.baseBranch ?? undefined,
    identity,
  );
  if (result.isErr()) throw result.error;

  const prUrl = result.value;
  const prData = { title: params.title, url: prUrl };

  await saveThreadEvent(params.threadId, 'git:pr_created', prData);
  wsBroker.emitToUser(params.userId, {
    type: 'thread:event',
    threadId: params.threadId,
    data: {
      event: {
        id: crypto.randomUUID(),
        threadId: params.threadId,
        type: 'git:pr_created',
        data: JSON.stringify(prData),
        createdAt: new Date().toISOString(),
      },
    },
  });

  return prUrl;
}
