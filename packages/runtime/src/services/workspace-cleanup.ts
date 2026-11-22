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
import { projectSearchRegistry } from './project-search-registry.js';
import { killPtysUnderPath } from './pty-manager.js';

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
  removeDirectory: (dir: string) => Promise<void>;
  trackActivity: typeof defaultTrackActivity;
  recordActivity: typeof defaultRecordActivity;
}

function messageOf(error: unknown): string {
  if (error && typeof error === 'object' && 'message' in error) {
    return String((error as { message: unknown }).message);
  }
  return String(error);
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
  removeDirectory: (dir) => rm(dir, { recursive: true, force: true }),
  trackActivity: defaultTrackActivity,
  recordActivity: defaultRecordActivity,
};

function samePath(a: string, b: string): boolean {
  return normalize(resolve(a)).replace(/\/+$/, '') === normalize(resolve(b)).replace(/\/+$/, '');
}

export function createWorkspaceCleanup(overrides: Partial<WorkspaceCleanupDeps> = {}) {
  const deps: WorkspaceCleanupDeps = { ...defaultDeps, ...overrides };

  /** Refuses anything but a registered worktree of the project (never the main checkout). */
  async function validateTarget(
    projectPath: string,
    worktreePath: string,
  ): Promise<DomainError | null> {
    if (samePath(projectPath, worktreePath)) {
      return badRequest('Refusing to remove the project checkout');
    }
    const outside = deps.checkWorktreePathInProject(projectPath, worktreePath);
    if (outside) return outside;
    const registered = await deps.isRegisteredWorktreePath(projectPath, worktreePath);
    if (registered.isErr()) return registered.error;
    if (!registered.value) {
      return badRequest(`${worktreePath} is not a worktree of this project`);
    }
    return null;
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
    await deps.invalidateSearchIndex(dir);
  }

  /**
   * Removes a thread's worktree, and its branch when `deleteBranch`, as one
   * `workspace.cleanup` activity. Processes inside are stopped first. A failed
   * step ends the activity `failed` with the effects so far; the branch step
   * still runs when the worktree was removed.
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

        const refused = await validateTarget(request.projectPath, request.worktreePath);
        if (refused) return err(refused);

        activity.step('Stopping processes');
        const stopped: ActivityEffect[] = [];
        await stopProcessesUnder(request.worktreePath, stopped);
        for (const effect of stopped) note(effect);

        activity.step('Removing worktree');
        const removed = await deps.removeWorktree(request.projectPath, request.worktreePath);
        if (removed.isErr()) return err(removed.error);
        note({ effect: 'worktree-removed', target: request.worktreePath });

        if (request.deleteBranch && branch) {
          activity.step('Deleting branch');
          const deleted = await deps.removeBranch(request.projectPath, branch);
          if (deleted.isErr()) return err(deleted.error);
          note({ effect: 'branch-deleted', target: branch });
        }
        return ok({ effects });
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
        await deps.recordActivity(
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
