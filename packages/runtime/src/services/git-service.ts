/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain emits: git:staged, git:unstaged, git:reverted, git:committed, git:pushed, git:pulled, git:merged, git:stashed, git:stash-popped, git:stash-dropped, git:reset-soft, git:checkout, git:revert, git:reset-hard
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
  stashFiles as gitStashFiles,
  stashPop as gitStashPop,
  stashDrop as gitStashDrop,
  resetSoft as gitResetSoft,
  createPR as gitCreatePR,
  git,
  gitRead,
  invalidateStatusCache,
  sanitizePath,
  removeWorktree,
  removeBranch,
  type GitIdentityOptions,
  type PullStrategy,
} from '@funny/core/git';
import type { WSEvent } from '@funny/shared';
import type { DomainError } from '@funny/shared/errors';
import { badRequest, internal, notFound } from '@funny/shared/errors';
import { type Result, ResultAsync, err, errAsync, ok } from 'neverthrow';

import { log } from '../lib/logger.js';
import { getServices } from './service-registry.js';
import { threadEventBus } from './thread-event-bus.js';
import * as tm from './thread-manager.js';
import { wsBroker } from './ws-broker.js';

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Resolve per-user git identity from the user's profile.
 */
export async function resolveIdentity(userId: string): Promise<GitIdentityOptions | undefined> {
  const author = (await getServices().profile.getGitIdentity(userId)) ?? undefined;
  const githubToken = (await getServices().profile.getGithubToken(userId)) ?? undefined;
  if (!author && !githubToken) return undefined;
  return { author, githubToken };
}

/** Validate that all file paths stay within the working directory. */
export function validateFilePaths(cwd: string, paths: string[]): Result<void, DomainError> {
  for (const p of paths) {
    const result = sanitizePath(cwd, p);
    if (result.isErr()) return err(badRequest(`Invalid path: ${p}`));
  }
  return ok(undefined);
}

async function getProjectId(threadId: string): Promise<string> {
  return (await tm.getThread(threadId))?.projectId ?? '';
}

// ── Thread-scoped git operations ────────────────────────────────

export function stage(
  threadId: string,
  userId: string,
  cwd: string,
  paths: string[],
  workflowId?: string,
): ResultAsync<void, DomainError> {
  return gitStage(cwd, paths).map(async () => {
    threadEventBus.emit('git:staged', {
      threadId,
      userId,
      projectId: await getProjectId(threadId),
      paths,
      cwd,
      workflowId,
    });
    invalidateStatusCache(cwd);
  });
}

export function unstage(
  threadId: string,
  userId: string,
  cwd: string,
  paths: string[],
  workflowId?: string,
): ResultAsync<void, DomainError> {
  return gitUnstage(cwd, paths).map(async () => {
    threadEventBus.emit('git:unstaged', {
      threadId,
      userId,
      projectId: await getProjectId(threadId),
      paths,
      cwd,
      workflowId,
    });
    invalidateStatusCache(cwd);
  });
}

export function revert(
  threadId: string,
  userId: string,
  cwd: string,
  paths: string[],
  workflowId?: string,
): ResultAsync<void, DomainError> {
  return gitRevert(cwd, paths).map(async () => {
    threadEventBus.emit('git:reverted', {
      threadId,
      userId,
      projectId: await getProjectId(threadId),
      paths,
      cwd,
      workflowId,
    });
    invalidateStatusCache(cwd);
  });
}

export function commitChanges(
  threadId: string,
  userId: string,
  cwd: string,
  message: string,
  amend?: boolean,
  noVerify?: boolean,
  workflowId?: string,
): ResultAsync<{ output: string; sha?: string }, DomainError> {
  return ResultAsync.fromSafePromise(resolveIdentity(userId)).andThen((identity) =>
    gitCommit(cwd, message, identity, amend, noVerify).andThen((output) => {
      // Capture the SHA of the newly created commit (non-critical)
      return ResultAsync.fromSafePromise(
        gitRead(['rev-parse', 'HEAD'], { cwd, reject: false })
          .then((shaResult) => (shaResult.exitCode === 0 ? shaResult.stdout.trim() : undefined))
          .catch(() => undefined),
      ).map(async (commitSha) => {
        threadEventBus.emit('git:committed', {
          threadId,
          userId,
          projectId: await getProjectId(threadId),
          message,
          amend,
          cwd,
          commitSha,
          workflowId,
        });
        invalidateStatusCache(cwd);
        return { output, sha: commitSha };
      });
    }),
  );
}

export function pushChanges(
  threadId: string,
  userId: string,
  cwd: string,
  workflowId?: string,
): ResultAsync<string, DomainError> {
  return ResultAsync.fromSafePromise(resolveIdentity(userId)).andThen((identity) =>
    gitPush(cwd, identity).map(async (output) => {
      threadEventBus.emit('git:pushed', {
        threadId,
        userId,
        projectId: await getProjectId(threadId),
        cwd,
        workflowId,
      });
      invalidateStatusCache(cwd);
      return output;
    }),
  );
}

export function pullChanges(
  threadId: string,
  userId: string,
  cwd: string,
  strategy: PullStrategy = 'ff-only',
): ResultAsync<string, DomainError> {
  return ResultAsync.fromSafePromise(resolveIdentity(userId)).andThen((identity) =>
    gitPull(cwd, strategy, identity).map(async (output) => {
      threadEventBus.emit('git:pulled', {
        threadId,
        userId,
        projectId: await getProjectId(threadId),
        cwd,
        output,
      });
      invalidateStatusCache(cwd);
      return output;
    }),
  );
}

export function stashChanges(
  threadId: string,
  userId: string,
  cwd: string,
): ResultAsync<string, DomainError> {
  return gitStash(cwd).map(async (output) => {
    threadEventBus.emit('git:stashed', {
      threadId,
      userId,
      projectId: await getProjectId(threadId),
      cwd,
      output,
    });
    invalidateStatusCache(cwd);
    return output;
  });
}

export function stashSelectedFiles(
  threadId: string,
  userId: string,
  cwd: string,
  files: string[],
): ResultAsync<string, DomainError> {
  return gitStashFiles(cwd, files).map(async (output) => {
    threadEventBus.emit('git:stashed', {
      threadId,
      userId,
      projectId: await getProjectId(threadId),
      cwd,
      output,
    });
    invalidateStatusCache(cwd);
    return output;
  });
}

export function popStash(
  threadId: string,
  userId: string,
  cwd: string,
): ResultAsync<string, DomainError> {
  return gitStashPop(cwd).map(async (output) => {
    threadEventBus.emit('git:stash-popped', {
      threadId,
      userId,
      projectId: await getProjectId(threadId),
      cwd,
      output,
    });
    invalidateStatusCache(cwd);
    return output;
  });
}

export function dropStash(
  threadId: string,
  userId: string,
  cwd: string,
  stashIndex: number,
): ResultAsync<string, DomainError> {
  return gitStashDrop(cwd, stashIndex).map(async (output) => {
    threadEventBus.emit('git:stash-dropped', {
      threadId,
      userId,
      projectId: await getProjectId(threadId),
      cwd,
      output,
    });
    invalidateStatusCache(cwd);
    return output;
  });
}

export function softReset(
  threadId: string,
  userId: string,
  cwd: string,
): ResultAsync<string, DomainError> {
  return gitResetSoft(cwd).map(async (output) => {
    threadEventBus.emit('git:reset-soft', {
      threadId,
      userId,
      projectId: await getProjectId(threadId),
      cwd,
      output,
    });
    invalidateStatusCache(cwd);
    return output;
  });
}

export function checkoutHash(
  threadId: string,
  userId: string,
  cwd: string,
  hash: string,
): ResultAsync<string, DomainError> {
  return git(['checkout', hash], cwd).map(async (output) => {
    threadEventBus.emit('git:checkout', {
      threadId,
      userId,
      projectId: await getProjectId(threadId),
      cwd,
      hash,
      output,
    });
    invalidateStatusCache(cwd);
    return output;
  });
}

export function revertCommit(
  threadId: string,
  userId: string,
  cwd: string,
  hash: string,
): ResultAsync<string, DomainError> {
  return ResultAsync.fromSafePromise(resolveIdentity(userId)).andThen((identity) => {
    const env = identity?.githubToken ? { GH_TOKEN: identity.githubToken } : undefined;
    return git(['revert', hash, '--no-edit'], cwd, env).map(async (output) => {
      threadEventBus.emit('git:revert', {
        threadId,
        userId,
        projectId: await getProjectId(threadId),
        cwd,
        hash,
        output,
      });
      invalidateStatusCache(cwd);
      return output;
    });
  });
}

export function resetHard(
  threadId: string,
  userId: string,
  cwd: string,
  hash: string,
): ResultAsync<string, DomainError> {
  return git(['reset', '--hard', hash], cwd).map(async (output) => {
    threadEventBus.emit('git:reset-hard', {
      threadId,
      userId,
      projectId: await getProjectId(threadId),
      cwd,
      hash,
      output,
    });
    invalidateStatusCache(cwd);
    return output;
  });
}

// ── Merge ───────────────────────────────────────────────────────

export interface MergeParams {
  threadId: string;
  userId: string;
  targetBranch?: string;
  push?: boolean;
  cleanup?: boolean;
}

export function merge(params: MergeParams): ResultAsync<string, DomainError> {
  return ResultAsync.fromSafePromise(
    (async () => {
      const thread = await tm.getThread(params.threadId);
      if (!thread || !thread.branch) {
        return { err: badRequest('Merge requires a thread with a branch') } as const;
      }

      const project = await getServices().projects.getProject(thread.projectId);
      if (!project) return { err: notFound('Project not found') } as const;

      return { thread, project } as const;
    })(),
  ).andThen((lookup) => {
    if ('err' in lookup) return errAsync(lookup.err);
    const { thread, project } = lookup;

    const targetBranch = params.targetBranch || thread.baseBranch;
    if (!targetBranch) {
      return errAsync(badRequest('No target branch specified and no baseBranch set on thread'));
    }

    return ResultAsync.fromSafePromise(resolveIdentity(params.userId)).andThen((identity) =>
      gitMerge(
        project.path,
        thread.branch,
        targetBranch,
        identity,
        thread.worktreePath ?? undefined,
      ).andThen((mergeOutput) => {
        threadEventBus.emit('git:merged', {
          threadId: params.threadId,
          userId: params.userId,
          projectId: thread.projectId,
          sourceBranch: thread.branch!,
          targetBranch,
          output: mergeOutput,
        });

        return ResultAsync.fromSafePromise(
          (async () => {
            if (params.push) {
              const env = identity?.githubToken ? { GH_TOKEN: identity.githubToken } : undefined;
              const pushResult = await git(['push', 'origin', targetBranch], project.path, env);
              if (pushResult.isErr()) {
                return err<string, DomainError>(
                  internal(`Merge succeeded but push failed: ${pushResult.error.message}`),
                );
              }
            }

            if (params.cleanup && thread.worktreePath) {
              await removeWorktree(project.path, thread.worktreePath).catch((e) =>
                log.warn('Worktree directory could not be removed (will be orphaned)', {
                  namespace: 'git',
                  worktreePath: thread.worktreePath,
                  error: String(e),
                }),
              );

              await removeBranch(project.path, thread.branch!).catch((e) =>
                log.warn('Failed to remove branch after merge', {
                  namespace: 'git',
                  error: String(e),
                }),
              );
              await tm.updateThread(params.threadId, {
                worktreePath: null,
                branch: null,
                mode: 'local',
                mergedAt: new Date().toISOString(),
              });

              // Notify sidebar/client that thread structure changed
              wsBroker.emitToUser(params.userId, {
                type: 'thread:updated',
                threadId: params.threadId,
                data: {
                  branch: null,
                  worktreePath: null,
                  mode: 'local',
                  mergedAt: new Date().toISOString(),
                },
              });

              // Calculate actual unpushed commits on the target branch after merge
              let unpushedCommitCount = 0;
              const countResult = await git(
                ['rev-list', '--count', `origin/${targetBranch}..${targetBranch}`],
                project.path,
              );
              if (countResult.isOk()) {
                unpushedCommitCount = parseInt(countResult.value.trim(), 10) || 0;
              }

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
                      unpulledCommitCount: 0,
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
            return ok<string, DomainError>(mergeOutput);
          })(),
        ).andThen((r) => r);
      }),
    );
  });
}

// ── Create Pull Request ─────────────────────────────────────────

export interface CreatePRParams {
  threadId: string;
  userId: string;
  cwd: string;
  title: string;
  body: string;
}

export function createPullRequest(params: CreatePRParams): ResultAsync<string, DomainError> {
  return ResultAsync.fromSafePromise(tm.getThread(params.threadId)).andThen((thread) =>
    ResultAsync.fromSafePromise(resolveIdentity(params.userId)).andThen((identity) =>
      gitCreatePR(
        params.cwd,
        params.title,
        params.body,
        thread?.baseBranch ?? undefined,
        identity,
      ).andThen((prUrl) => {
        const prData = { title: params.title, url: prUrl };
        return ResultAsync.fromSafePromise(
          getServices()
            .threadEvents.saveThreadEvent(params.threadId, 'git:pr_created', prData)
            .then(() => {
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
            }),
        );
      }),
    ),
  );
}
