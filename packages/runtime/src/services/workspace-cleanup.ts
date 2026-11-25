/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: ActivityTracker, CommandRunner, PtyManager, ProjectSearchRegistry
 *
 * The one runner module that removes a workspace (track-funny-actions, design
 * D3): a thread's worktree and branch, the orphan folders of a worktree base,
 * and a scratch thread's directory. Every removal stops the commands and
 * closes the terminals running inside it first, validates the target, and is
 * recorded as one activity with its reason and the list of what it removed.
 *
 * `scripts/fitness/check-workspace-removal.ts` fails on any other runner code
 * that imports `removeWorktree`, `removeBranch` or `pruneOrphanWorktrees`.
 */
import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { basename, normalize, resolve } from 'path';

import {
  checkWorktreePathInProject,
  isRegisteredWorktreePath,
  pruneOrphanWorktrees,
  removeBranch,
  removeWorktree,
} from '@funny/core/git';
import type { ActivityEffect, ActivityOrigin } from '@funny/shared';
import type { WorkspaceCleanupReason } from '@funny/shared/activities';
import { badRequest, internal, type DomainError } from '@funny/shared/errors';
import { err, ok, ResultAsync, type Result } from 'neverthrow';

import { log } from '../lib/logger.js';
import {
  recordActivity as defaultRecordActivity,
  trackActivity as defaultTrackActivity,
} from './activity-tracker.js';
import { stopCommandsByCwd } from './command-runner.js';
import { removeThreadCheckpoints } from './git-checkpoints.js';
import { projectSearchRegistry } from './project-search-registry.js';
import { killPtysUnderPath } from './pty-manager.js';
import { forgetProjectIndex } from './symbol-index-service.js';

export interface WorkspaceCleanupRequest {
  userId: string;
  projectId: string;
  projectPath: string;
  threadId?: string | null;
  worktreePath: string;
  branch?: string | null;
  deleteBranch: boolean;
  reason: WorkspaceCleanupReason;
  /** Default: `user` for a `manual` cleanup, `implicit` otherwise. */
  origin?: ActivityOrigin;
}

export interface CleanupOutcome {
  effects: ActivityEffect[];
}

export interface WorkspaceCleanupDeps {
  isRegisteredWorktreePath: typeof isRegisteredWorktreePath;
  checkWorktreePathInProject: typeof checkWorktreePathInProject;
  removeWorktree: typeof removeWorktree;
  removeBranch: typeof removeBranch;
  pruneOrphanWorktrees: typeof pruneOrphanWorktrees;
  stopCommandsByCwd: (cwd: string) => Promise<string[]>;
  killPtysUnderPath: (dir: string) => string[];
  invalidateSearchIndex: (cwd: string) => Promise<void>;
  /** Evicts the cached symbol index of a removed directory (#408). */
  forgetSymbolIndex: (dir: string) => void;
  removeDirectory: (dir: string) => Promise<void>;
  pathExists: (path: string) => boolean;
  /** Drops a thread's rewind checkpoints from the project repository. */
  removeThreadCheckpoints: (projectPath: string, threadId: string) => Promise<number>;
  trackActivity: typeof defaultTrackActivity;
  recordActivity: typeof defaultRecordActivity;
}

function messageOf(cause: unknown): string {
  if (cause && typeof cause === 'object' && 'message' in cause) {
    return String((cause as { message: unknown }).message);
  }
  return String(cause);
}

const defaultDeps: WorkspaceCleanupDeps = {
  isRegisteredWorktreePath,
  checkWorktreePathInProject,
  removeWorktree,
  removeBranch,
  pruneOrphanWorktrees,
  stopCommandsByCwd,
  killPtysUnderPath,
  invalidateSearchIndex: (cwd) =>
    projectSearchRegistry.invalidate(cwd).match(
      () => undefined,
      (error) => {
        log.warn('Failed to dispose workspace search index', {
          namespace: 'workspace-cleanup',
          error: error.message,
        });
      },
    ),
  forgetSymbolIndex: (dir) => {
    forgetProjectIndex(dir);
  },
  removeDirectory: (dir) => rm(dir, { recursive: true, force: true }),
  pathExists: existsSync,
  removeThreadCheckpoints,
  trackActivity: defaultTrackActivity,
  recordActivity: defaultRecordActivity,
};

function samePath(a: string, b: string): boolean {
  return normalize(resolve(a)).replace(/\/+$/, '') === normalize(resolve(b)).replace(/\/+$/, '');
}

export function createWorkspaceCleanup(overrides: Partial<WorkspaceCleanupDeps> = {}) {
  const deps: WorkspaceCleanupDeps = { ...defaultDeps, ...overrides };

  /**
   * Refuses anything but a worktree of the project (never the main checkout).
   * A worktree inside the project's worktree base that git no longer lists and
   * whose folder is gone (pruned, removed from the settings screen) is already
   * removed: `gone`, and the branch step still runs.
   */
  async function validateTarget(
    projectPath: string,
    worktreePath: string,
  ): Promise<DomainError | 'gone' | null> {
    if (samePath(projectPath, worktreePath)) {
      return badRequest('Refusing to remove the project checkout');
    }
    const outside = deps.checkWorktreePathInProject(projectPath, worktreePath);
    if (outside) return outside;
    const registered = await deps.isRegisteredWorktreePath(projectPath, worktreePath);
    if (registered.isErr()) return registered.error;
    if (registered.value) return null;
    if (!deps.pathExists(worktreePath)) return 'gone';
    return badRequest(`${worktreePath} is not a worktree of this project`);
  }

  /** A thread's rewind checkpoints go with its workspace (track-pipeline-runs, D3). */
  async function dropThreadCheckpoints(request: WorkspaceCleanupRequest): Promise<void> {
    if (!request.threadId) return;
    await deps.removeThreadCheckpoints(request.projectPath, request.threadId).catch((error) =>
      log.warn('Failed to remove thread checkpoints', {
        namespace: 'workspace-cleanup',
        threadId: request.threadId,
        error: messageOf(error),
      }),
    );
  }

  /** Stops what runs inside `dir`; each stopped thing becomes an effect. */
  async function stopProcessesUnder(dir: string, effects: ActivityEffect[]): Promise<void> {
    const commands = await deps.stopCommandsByCwd(dir).catch((error) => {
      log.warn('Failed to stop commands before removal', {
        namespace: 'workspace-cleanup',
        dir,
        error: messageOf(error),
      });
      return [] as string[];
    });
    for (const command of commands) effects.push({ effect: 'command-stopped', target: command });
    for (const terminal of deps.killPtysUnderPath(dir)) {
      effects.push({ effect: 'terminal-closed', target: terminal });
    }
    deps.forgetSymbolIndex(dir);
    await deps.invalidateSearchIndex(dir);
  }

  /**
   * Removes a thread's worktree, and its branch when `deleteBranch`, as one
   * `workspace.cleanup` activity. Processes inside are stopped first. A failed
   * step ends the activity `failed` with the effects that did happen; the
   * branch step runs whatever happened to the worktree.
   */
  function cleanupWorkspace(
    request: WorkspaceCleanupRequest,
  ): ResultAsync<CleanupOutcome, DomainError> {
    const branch = request.branch && !request.branch.startsWith('-') ? request.branch : undefined;
    const run = deps.trackActivity(
      {
        kind: 'workspace.cleanup',
        userId: request.userId,
        projectId: request.projectId,
        threadId: request.threadId ?? null,
        title: `Clean up worktree ${basename(request.worktreePath)}`,
        input: {
          reason: request.reason,
          branch,
          deleteBranch: request.deleteBranch && !!branch,
        },
        origin: request.origin ?? (request.reason === 'manual' ? 'user' : 'implicit'),
      },
      async (activity): Promise<Result<CleanupOutcome, DomainError>> => {
        const effects: ActivityEffect[] = [];
        const note = (effect: ActivityEffect) => {
          effects.push(effect);
          activity.effect(effect.effect, effect.target);
        };

        const target = await validateTarget(request.projectPath, request.worktreePath);
        if (target !== null && target !== 'gone') return err(target);

        // The worktree step; an already-removed worktree has nothing to stop.
        let worktreeError: DomainError | null = null;
        if (target !== 'gone') {
          activity.step('Stopping processes');
          const stopped: ActivityEffect[] = [];
          await stopProcessesUnder(request.worktreePath, stopped);
          for (const effect of stopped) note(effect);

          activity.step('Removing worktree');
          const removed = await deps.removeWorktree(request.projectPath, request.worktreePath);
          if (removed.isErr()) worktreeError = removed.error;
          else note({ effect: 'worktree-removed', target: request.worktreePath });
        }

        // The branch step runs even when the worktree could not be removed (git
        // refuses a branch still checked out there, which is then reported).
        let branchError: DomainError | null = null;
        if (request.deleteBranch && branch) {
          activity.step('Deleting branch');
          const deleted = await deps.removeBranch(request.projectPath, branch);
          if (deleted.isErr()) branchError = deleted.error;
          else note({ effect: 'branch-deleted', target: branch });
        }
        await dropThreadCheckpoints(request);
        const failure = worktreeError ?? branchError;
        return failure ? err(failure) : ok({ effects });
      },
    );
    return ResultAsync.fromPromise(run, (error) => internal(messageOf(error))).andThen(
      (result) => result,
    );
  }

  /**
   * Removes the folders of the project's worktree bases that git no longer
   * registers. Records `workspace.prune` only when it removed something.
   */
  function pruneOrphans(request: {
    userId: string;
    projectId: string;
    projectPath: string;
  }): ResultAsync<number, DomainError> {
    return deps.pruneOrphanWorktrees(request.projectPath).map(async (removed) => {
      if (removed.length > 0) {
        // Not awaited: the report retries while disconnected, and listing the
        // worktrees must not wait for it.
        void deps.recordActivity(
          {
            kind: 'workspace.prune',
            userId: request.userId,
            projectId: request.projectId,
            title:
              removed.length === 1
                ? 'Removed 1 orphan worktree folder'
                : `Removed ${removed.length} orphan worktree folders`,
            input: {},
            origin: 'implicit',
          },
          {
            ok: true,
            effects: removed.map((dir) => ({ effect: 'directory-removed' as const, target: dir })),
          },
        );
      }
      return removed.length;
    });
  }

  /**
   * Removes a scratch thread's directory (the caller derives it with
   * `scratchPathFor`, never from a request) after closing its terminals.
   */
  function removeScratchWorkspace(request: {
    userId: string;
    threadId: string;
    scratchPath: string;
  }): ResultAsync<CleanupOutcome, DomainError> {
    const run = deps.trackActivity(
      {
        kind: 'workspace.cleanup',
        userId: request.userId,
        threadId: request.threadId,
        title: 'Remove scratch directory',
        input: { reason: 'thread-deleted', deleteBranch: false },
        origin: 'implicit',
      },
      async (activity): Promise<Result<CleanupOutcome, DomainError>> => {
        const effects: ActivityEffect[] = [];
        await stopProcessesUnder(request.scratchPath, effects);
        try {
          await deps.removeDirectory(request.scratchPath);
        } catch (error) {
          for (const effect of effects) activity.effect(effect.effect, effect.target);
          return err(internal(`Failed to remove ${request.scratchPath}: ${messageOf(error)}`));
        }
        effects.push({ effect: 'directory-removed', target: request.scratchPath });
        for (const effect of effects) activity.effect(effect.effect, effect.target);
        return ok({ effects });
      },
    );
    return ResultAsync.fromPromise(run, (error) => internal(messageOf(error))).andThen(
      (result) => result,
    );
  }

  return { cleanupWorkspace, pruneOrphans, removeScratchWorkspace };
}

const workspaceCleanup = createWorkspaceCleanup();

export const cleanupWorkspace = workspaceCleanup.cleanupWorkspace;
export const pruneOrphans = workspaceCleanup.pruneOrphans;
export const removeScratchWorkspace = workspaceCleanup.removeScratchWorkspace;
