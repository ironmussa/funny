/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { git, gitRead, type BranchPRInfo, type GitIdentityOptions } from '@funny/core/git';
import { badRequest, type DomainError } from '@funny/shared/errors';
import type { Context } from 'hono';
import { err, ok, type Result } from 'neverthrow';

import { metric } from '../../lib/telemetry.js';
import {
  GIT_STATUS_CACHE_TTL_MS,
  gitRuntimeService,
  gitStatusCache,
} from '../../services/git-runtime-service.js';
import { wsBroker } from '../../services/ws-broker.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { requireProject, requireThreadCwd, steerFromContext } from '../../utils/route-helpers.js';
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

/** Coalesces change notices from one project's summaries (a bulk status can refresh many). */
const STATUS_CHANGE_DEBOUNCE_MS = 250;
const pendingStatusChanges = new Map<string, { threadId: string; timer: Timer }>();

/**
 * `onChanged` for `getStatusSummary`: a read may return a stale summary while a
 * newer one is computed in the background. When the newer one differs, drop
 * the project's bulk status (it was built from the stale summary) and hint the
 * client to refetch — the same `git:refs-updated` path a background fetch uses.
 */
export function notifyStatusChanged(userId: string, projectId: string, threadId = '') {
  return () => {
    // Counts stale summaries that turned out wrong: how often SWR served old data.
    metric('git.status.stale_changed', 1, { attributes: { projectId } });
    const key = `${userId}|${projectId}`;
    const pending = pendingStatusChanges.get(key);
    if (pending) {
      // Several threads changed: the hint stays project-wide.
      if (pending.threadId !== threadId) pending.threadId = '';
      return;
    }
    const timer = setTimeout(() => {
      const fired = pendingStatusChanges.get(key);
      pendingStatusChanges.delete(key);
      gitRuntimeService.invalidateProjectStatus(projectId);
      wsBroker.emitToUser(userId, {
        type: 'git:refs-updated',
        threadId: fired?.threadId ?? threadId,
        data: { projectId, changed: ['status'] },
      });
    }, STATUS_CHANGE_DEBOUNCE_MS);
    pendingStatusChanges.set(key, { threadId, timer });
  };
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

/** Working directory of the route's `:projectId`, for the requesting user and organization. */
export function requireProjectCwdFromContext(
  c: Context<HonoEnv>,
): Promise<Result<string, DomainError>> {
  return requireProjectCwd(
    c.req.param('projectId') as string,
    c.get('userId') as string,
    c.get('organizationId'),
  );
}

/**
 * Working directory of the route's `:threadId`, for the requesting user.
 * Steer sharees are allowed (thread-sharing-steer): use it only on routes on
 * the steer allow-list.
 */
export function requireSteerableThreadCwdFromContext(
  c: Context<HonoEnv>,
): Promise<Result<string, DomainError>> {
  return requireThreadCwd(
    c.req.param('threadId') as string,
    c.get('userId') as string,
    steerFromContext(c),
  );
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
