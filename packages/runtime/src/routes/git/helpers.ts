/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { git, gitRead, type BranchPRInfo, type GitIdentityOptions } from '@funny/core/git';
import { badRequest, type DomainError } from '@funny/shared/errors';
import { err, ok, type Result } from 'neverthrow';

import {
  GIT_STATUS_CACHE_TTL_MS,
  gitRuntimeService,
  gitStatusCache,
} from '../../services/git-runtime-service.js';
import { wsBroker } from '../../services/ws-broker.js';
import { requireProject } from '../../utils/route-helpers.js';
import { requireWorkingDirectory } from '../../utils/working-directory.js';

// computeBranchKey is imported from utils/git-status-helpers.ts

// In-memory cache for bulk git status to avoid spawning excessive git processes.
export { GIT_STATUS_CACHE_TTL_MS };
export const _gitStatusCache = gitStatusCache;

// The per-branch PR info cache lives in services/pr-info-cache.ts so the
// `git:changed` status path shares it with these routes.
export { getCachedPR, schedulePRLookup } from '../../services/pr-info-cache.js';

/**
 * Emit a `git:status` WS event for a single thread carrying just the PR fields.
 * Client merges by `branchKey`, so the existing status fields stay intact and
 * the PR badge appears as soon as the background lookup resolves.
 */
export function emitPRUpdateForThread(opts: {
  userId: string;
  threadId: string;
  branchKey: string;
  status: Record<string, unknown>;
  pr: BranchPRInfo | null;
}): void {
  const { userId, threadId, branchKey, status, pr } = opts;
  const merged = {
    ...status,
    threadId,
    branchKey,
    ...(pr ? { prNumber: pr.prNumber, prUrl: pr.prUrl, prState: pr.prState } : {}),
  };
  wsBroker.emitToUser(userId, {
    type: 'git:status',
    threadId,
    data: {
      statuses: [merged as unknown as import('@funny/shared').GitStatusInfo],
      prOnly: true,
    },
  });
}

/** Invalidate cached git status for a project after mutating git operations. */
export async function invalidateGitStatusCache(threadId: string) {
  await gitRuntimeService.invalidateThreadStatus(threadId);
}

/** Invalidate cached git status by project ID directly. Exported for use by event handlers. */
export function invalidateGitStatusCacheByProject(projectId: string) {
  gitRuntimeService.invalidateProjectStatus(projectId);
}

/**
 * Throttled background `git fetch`. Returns immediately; the network fetch runs
 * detached so /api/git/status responses aren't blocked by remote round-trips.
 * On completion, BOTH the per-project bulk cache and the core cwd-keyed summary
 * cache are invalidated so the next status call recomputes `unpulledCommitCount`
 * against the freshly updated refs, then `onFetched` fires so the caller can
 * broadcast the recomputed status over WS — otherwise the incoming-commit badge
 * only appears on a later manual refresh (the fetch landed after the response).
 *
 * Returns true when a fetch was scheduled, false when the throttle window
 * suppressed it. Callers don't need to await — the caller has already moved on.
 */
export function scheduleBackgroundFetch(
  projectId: string,
  projectPath: string,
  identity: GitIdentityOptions | undefined,
  attrs?: Record<string, string | number | boolean>,
  onFetched?: () => void | Promise<void>,
): boolean {
  return gitRuntimeService.scheduleBackgroundFetch({
    projectId,
    projectPath,
    identity,
    attrs,
    onFetched,
  });
}

/** Count unpushed commits on a branch vs its remote tracking branch. */
export async function countUnpushedCommits(projectPath: string, branch: string): Promise<number> {
  try {
    const result = await git(['rev-list', '--count', `origin/${branch}..${branch}`], projectPath);
    if (result.isOk()) return parseInt(result.value.trim(), 10) || 0;
  } catch {
    /* remote tracking branch may not exist */
  }
  return 0;
}

/** Resolve project path from projectId and verify ownership. */
export async function requireProjectCwd(
  projectId: string,
  userId?: string,
  organizationId?: string | null,
): Promise<import('neverthrow').Result<string, import('@funny/shared/errors').DomainError>> {
  const projectResult = await requireProject(projectId, userId, organizationId ?? undefined);
  if (projectResult.isErr()) return projectResult.map(() => '');
  return requireWorkingDirectory(projectResult.value.path);
}

/**
 * Validate that a path is a real checked-out work tree before serving UI data
 * that depends on working-tree state. Bare repositories can still answer some
 * history commands, but changes and graph context become misleading/incomplete.
 */
export async function requireGitWorkingTree(cwd: string): Promise<Result<void, DomainError>> {
  const directory = requireWorkingDirectory(cwd);
  if (directory.isErr()) return err(directory.error);
  const result = await gitRead(['rev-parse', '--is-inside-work-tree'], {
    cwd,
    reject: false,
  });
  if (result.exitCode === 0 && result.stdout.trim() === 'true') {
    return ok(undefined);
  }

  const detail = (result.stderr || result.stdout || 'not a git working tree').trim();
  return err(
    badRequest(
      `Git working tree unavailable: ${detail}. This path may be a bare repository or not a checked-out worktree.`,
    ),
  );
}
