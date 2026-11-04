/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { existsSync } from 'fs';

import {
  getStatusSummary,
  getCommittedBranchSummary,
  getCurrentBranch,
  deriveGitSyncState,
  type BranchPRInfo,
} from '@funny/core/git';
import { badRequest } from '@funny/shared/errors';
import { Hono, type Context } from 'hono';
import { err } from 'neverthrow';

import { startSpan } from '../../lib/telemetry.js';
import { requestSpan } from '../../middleware/tracing.js';
import { resolveIdentity } from '../../services/git-service.js';
import * as tm from '../../services/thread-manager.js';
import { wsBroker } from '../../services/ws-broker.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { computeBranchKey } from '../../utils/git-status-helpers.js';
import { resultToResponse } from '../../utils/result-response.js';
import {
  requireThread,
  requireProject,
  steerFromContext,
  isSteerGrantFor,
} from '../../utils/route-helpers.js';
import {
  _gitStatusCache,
  GIT_STATUS_CACHE_TTL_MS,
  countUnpushedCommits,
  emitPRUpdateForThread,
  getCachedPR,
  requireProjectCwd,
  scheduleBackgroundFetch,
  schedulePRLookup,
} from './helpers.js';

export const statusRoutes = new Hono<HonoEnv>();

/** Upper bound for `threadIds`; larger scopes fall back to the whole project. */
const MAX_SCOPED_THREAD_IDS = 200;

/**
 * Parse the optional `threadIds` scope (comma-separated). Returns null for the
 * whole project — also when the list is empty or too large to be worth scoping.
 */
function parseThreadScope(raw: string | undefined): Set<string> | null {
  if (!raw) return null;
  const ids = raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (ids.length === 0 || ids.length > MAX_SCOPED_THREAD_IDS) return null;
  return new Set(ids);
}

function getCachedScope(projectId: string, scopeKey: string) {
  const cached = _gitStatusCache.get(projectId);
  if (!cached || (cached.scope ?? '') !== scopeKey) return undefined;
  return Date.now() - cached.ts < GIT_STATUS_CACHE_TTL_MS ? cached : undefined;
}

// GET /api/git/status?projectId=xxx[&threadIds=a,b] — bulk git status for the
// project's threads, optionally scoped to the threads the client has on screen
// (a project can hold thousands of threads; the sidebar shows a handful).
statusRoutes.get('/status', async (c) => {
  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId required' }, 400);
  const threadScope = parseThreadScope(c.req.query('threadIds'));
  const scopeKey = threadScopeKey(threadScope);

  // Return cached result if still fresh (and computed for the same scope)
  const cached = getCachedScope(projectId, scopeKey);
  if (cached) return c.json(cached.data);

  const userId = c.get('userId') as string;
  const projectResult = await requireProject(
    projectId,
    userId,
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  // Concurrent misses for the same project + scope share one computation: the
  // client fires this alongside the per-thread status/diff calls, and every
  // extra run is another full working-tree scan competing for disk I/O.
  const inFlightKey = `${projectId}|${scopeKey}`;
  let pending = bulkStatusInFlight.get(inFlightKey);
  if (!pending) {
    pending = computeBulkStatus(c, { project, projectId, userId, threadScope, scopeKey });
    bulkStatusInFlight.set(inFlightKey, pending);
    const settled = pending;
    void settled.then(
      () => clearBulkStatusInFlight(inFlightKey, settled),
      () => clearBulkStatusInFlight(inFlightKey, settled),
    );
  }
  return c.json(await pending);
});

const bulkStatusInFlight = new Map<string, Promise<{ statuses: any[] }>>();

function clearBulkStatusInFlight(key: string, pending: Promise<{ statuses: any[] }>): void {
  if (bulkStatusInFlight.get(key) === pending) bulkStatusInFlight.delete(key);
}

interface BulkStatusInput {
  project: { path: string };
  projectId: string;
  userId: string;
  threadScope: Set<string> | null;
  scopeKey: string;
}

type ProjectThread = Awaited<ReturnType<typeof tm.listThreads>>['threads'][number];
type StatusSpan = ReturnType<typeof requestSpan>;

async function worktreeThreadStatus(
  thread: ProjectThread,
  projectPath: string,
  statusSpan: StatusSpan,
): Promise<any> {
  const span = startSpan('git.status_summary', {
    traceId: statusSpan.traceId,
    parentSpanId: statusSpan.spanId,
    attributes: { threadId: thread.id, mode: 'worktree' },
  });
  const summaryResult = await getStatusSummary(
    thread.worktreePath!,
    thread.baseBranch ?? undefined,
    projectPath,
  );
  span.end(
    summaryResult.isOk() ? 'ok' : 'error',
    summaryResult.isErr() ? summaryResult.error.message : undefined,
  );
  if (summaryResult.isErr()) return null;
  const summary = summaryResult.value;
  return Object.assign(
    {
      threadId: thread.id,
      branchKey: computeBranchKey(thread as any),
      state: deriveGitSyncState(summary),
    },
    summary,
  );
}

// Local threads share the project cwd, but only the thread on the
// currently checked-out branch reflects the working tree. Threads on other
// branches get committed-only diff stats (git diff base...branch) so they
// don't inherit the dirty state of whichever branch is checked out now.
async function localThreadStatuses(
  projectPath: string,
  projectId: string,
  localThreads: ProjectThread[],
  statusSpan: StatusSpan,
): Promise<Array<PromiseSettledResult<any>>> {
  const currentBranch = await currentBranchOf(projectPath, projectId, statusSpan);

  // Split threads: those matching the checked-out branch use working-tree
  // summary (shared); others compute committed-only summary per branch.
  const activeThreads: ProjectThread[] = [];
  const backgroundThreads: ProjectThread[] = [];
  for (const thread of localThreads) {
    if (thread.branch && thread.branch === currentBranch) activeThreads.push(thread);
    else backgroundThreads.push(thread);
  }

  const { byKey, unassigned } = groupByBranchPair(backgroundThreads);
  const [active, background] = await Promise.all([
    activeThreadStatuses(projectPath, projectId, activeThreads, statusSpan),
    Promise.all(
      Array.from(byKey.values()).map((threads) =>
        committedBranchStatuses(projectPath, projectId, threads, statusSpan),
      ),
    ),
  ]);
  return [...active, ...background.flat(), ...unassigned.map(cleanStatus)];
}

async function currentBranchOf(
  projectPath: string,
  projectId: string,
  statusSpan: StatusSpan,
): Promise<string | null> {
  const span = startSpan('git.current_branch', {
    traceId: statusSpan.traceId,
    parentSpanId: statusSpan.spanId,
    attributes: { projectId },
  });
  const result = await getCurrentBranch(projectPath);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  return result.isOk() ? result.value : null;
}

/**
 * Background threads grouped by unique (baseBranch, branch). Threads without a
 * branch or baseBranch are `unassigned` and reported with zero stats.
 */
function groupByBranchPair(threads: ProjectThread[]) {
  const byKey = new Map<string, ProjectThread[]>();
  const unassigned: ProjectThread[] = [];
  for (const thread of threads) {
    if (!thread.branch || !thread.baseBranch) {
      unassigned.push(thread);
      continue;
    }
    const key = `${thread.baseBranch}..${thread.branch}`;
    const group = byKey.get(key);
    if (group) group.push(thread);
    else byKey.set(key, [thread]);
  }
  return { byKey, unassigned };
}

/** One summary shared by every thread of a group; a failed summary yields null per thread. */
function sharedSummaryStatuses(
  summaryResult: Awaited<ReturnType<typeof getStatusSummary>>,
  threads: ProjectThread[],
): Array<PromiseSettledResult<any>> {
  if (summaryResult.isErr()) {
    return threads.map(() => ({ status: 'fulfilled' as const, value: null }));
  }
  const summary = summaryResult.value;
  const state = deriveGitSyncState(summary);
  return threads.map((t) => ({
    status: 'fulfilled' as const,
    value: Object.assign({ threadId: t.id, branchKey: computeBranchKey(t), state }, summary),
  }));
}

// Active group: one getStatusSummary call shared across all threads on
// the currently-checked-out branch.
async function activeThreadStatuses(
  projectPath: string,
  projectId: string,
  activeThreads: ProjectThread[],
  statusSpan: StatusSpan,
): Promise<Array<PromiseSettledResult<any>>> {
  if (activeThreads.length === 0) return [];
  const span = startSpan('git.status_summary', {
    traceId: statusSpan.traceId,
    parentSpanId: statusSpan.spanId,
    attributes: { projectId, mode: 'local-active', threadCount: activeThreads.length },
  });
  const summaryResult = await getStatusSummary(
    projectPath,
    activeThreads[0].baseBranch ?? undefined,
    projectPath,
  );
  span.end(
    summaryResult.isOk() ? 'ok' : 'error',
    summaryResult.isErr() ? summaryResult.error.message : undefined,
  );
  return sharedSummaryStatuses(summaryResult, activeThreads);
}

// Background group: committed-only diff shared by threads on one (baseBranch, branch).
async function committedBranchStatuses(
  projectPath: string,
  projectId: string,
  threads: ProjectThread[],
  statusSpan: StatusSpan,
): Promise<Array<PromiseSettledResult<any>>> {
  const rep = threads[0];
  const span = startSpan('git.committed_branch_summary', {
    traceId: statusSpan.traceId,
    parentSpanId: statusSpan.spanId,
    attributes: {
      projectId,
      baseBranch: rep.baseBranch!,
      branch: rep.branch!,
      threadCount: threads.length,
    },
  });
  const summaryResult = await getCommittedBranchSummary(projectPath, rep.baseBranch!, rep.branch!);
  span.end(
    summaryResult.isOk() ? 'ok' : 'error',
    summaryResult.isErr() ? summaryResult.error.message : undefined,
  );
  return sharedSummaryStatuses(summaryResult, threads);
}

function cleanStatus(t: ProjectThread): PromiseSettledResult<any> {
  return {
    status: 'fulfilled',
    value: {
      threadId: t.id,
      branchKey: computeBranchKey(t),
      state: 'clean' as const,
      dirtyFileCount: 0,
      unpushedCommitCount: 0,
      unpulledCommitCount: 0,
      hasRemoteBranch: false,
      isMergedIntoBase: false,
      linesAdded: 0,
      linesDeleted: 0,
    },
  };
}

interface ThreadGroups {
  worktreeThreads: ProjectThread[];
  mergedThreads: ProjectThread[];
  localThreads: ProjectThread[];
}

function groupThreadsByMode(threads: ProjectThread[]): ThreadGroups {
  return {
    worktreeThreads: threads.filter((t) => t.mode === 'worktree' && t.worktreePath && t.branch),
    // Merged threads: worktree was cleaned up after merge (mergedAt is set).
    // Without the mergedAt check, local-mode threads with branch=null would be
    // incorrectly classified as merged and always receive hardcoded zero stats.
    mergedThreads: threads.filter(
      (t) => !t.worktreePath && !t.branch && t.baseBranch && t.mergedAt,
    ),
    localThreads: threads.filter(
      (t) => !t.worktreePath && !(!t.branch && t.baseBranch && t.mergedAt),
    ),
  };
}

/** threadId → the branch whose PR the thread shows (merged threads: their base branch). */
function threadPRBranches({ worktreeThreads, localThreads, mergedThreads }: ThreadGroups) {
  const threadBranchMap = new Map<string, string>();
  for (const t of worktreeThreads) if (t.branch) threadBranchMap.set(t.id, t.branch);
  for (const t of localThreads) if (t.branch) threadBranchMap.set(t.id, t.branch);
  for (const t of mergedThreads) if (t.baseBranch) threadBranchMap.set(t.id, t.baseBranch);
  return threadBranchMap;
}

/** Split branches into cached PR metadata and cache misses that need a lookup. */
function cachedPRs(projectPath: string, branches: Iterable<string>) {
  const prByBranch = new Map<string, BranchPRInfo>();
  const branchesNeedingPRLookup: string[] = [];
  for (const branch of branches) {
    const cachedPR = getCachedPR(projectPath, branch);
    if (cachedPR === undefined) branchesNeedingPRLookup.push(branch);
    else if (cachedPR) prByBranch.set(branch, cachedPR);
  }
  return { prByBranch, branchesNeedingPRLookup };
}

function applyPR(status: any, pr: BranchPRInfo | null | undefined) {
  if (pr) {
    status.prNumber = pr.prNumber;
    status.prUrl = pr.prUrl;
    status.prState = pr.prState;
  }
  return status;
}

function fulfilledStatuses(results: Array<PromiseSettledResult<any>>): any[] {
  return results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter(Boolean);
}

async function mergedThreadStatus(c: Context<HonoEnv>, projectPath: string, t: ProjectThread) {
  let unpushed = 0;
  if (t.baseBranch) {
    const span = requestSpan(c, 'git.unpushed_count', {
      threadId: t.id,
      branch: t.baseBranch,
    });
    unpushed = await countUnpushedCommits(projectPath, t.baseBranch);
    span.end('ok');
  }
  return {
    threadId: t.id,
    branchKey: computeBranchKey(t),
    state: 'merged' as const,
    dirtyFileCount: 0,
    unpushedCommitCount: unpushed,
    unpulledCommitCount: 0,
    hasRemoteBranch: unpushed > 0,
    isMergedIntoBase: true,
    linesAdded: 0,
    linesDeleted: 0,
  };
}

/** Look up PRs for cache-missed branches after the response; push results over WS. */
function schedulePRRefreshes(input: {
  projectPath: string;
  userId: string;
  ghEnv: Record<string, string> | undefined;
  branches: string[];
  statuses: any[];
  threadBranchMap: Map<string, string>;
}): void {
  for (const branch of input.branches) {
    const matchingStatuses = input.statuses.filter(
      (status) => input.threadBranchMap.get(status.threadId) === branch,
    );
    if (matchingStatuses.length === 0) continue;
    schedulePRLookup({
      projectPath: input.projectPath,
      branch,
      ghEnv: input.ghEnv,
      onUpdate: (pr) => {
        for (const status of matchingStatuses) {
          applyPR(status, pr);
          emitPRUpdateForThread({
            userId: input.userId,
            threadId: status.threadId,
            branchKey: status.branchKey,
            status,
            pr,
          });
        }
      },
    });
  }
}

async function computeBulkStatus(
  c: Context<HonoEnv>,
  { project, projectId, userId, threadScope, scopeKey }: BulkStatusInput,
): Promise<{ statuses: any[] }> {
  const { threads: projectThreads } = await tm.listThreads({
    projectId,
    userId,
    isScratch: 'exclude',
  });
  const groups = groupThreadsByMode(filterThreadScope(projectThreads, threadScope));
  const { worktreeThreads, mergedThreads, localThreads } = groups;

  // Resolve GH_TOKEN for PR detection (runs once per request)
  const identity = await resolveIdentity(userId, projectId);
  const ghEnv = identity?.githubToken ? { GH_TOKEN: identity.githubToken } : undefined;

  // Background fetch: update remote tracking refs so unpulledCommitCount is
  // accurate on the *next* request. Detached so the response isn't blocked
  // by ~1s remote round-trips per project. Throttled per-project; on success
  // the bulk-status cache is invalidated so the next call sees fresh refs.
  // On completion, hint the client to re-fetch the bulk status through its
  // normal (now cache-fresh) path so newly-pushed origin commits surface
  // without a second manual refresh. The bulk recompute is heavy (all threads +
  // PR lookups), so we send a lightweight hint rather than recompute here.
  scheduleBackgroundFetch(projectId, project.path, identity ?? undefined, undefined, () => {
    wsBroker.emitToUser(userId, {
      type: 'git:refs-updated',
      threadId: '',
      data: { projectId },
    });
  });

  // Unique branches for batch PR lookup (deduplicated across all thread types)
  const threadBranchMap = threadPRBranches(groups);

  const statusSpan = requestSpan(c, 'git.status.aggregate', {
    projectId,
    worktreeCount: worktreeThreads.length,
    localCount: localThreads.length,
    mergedCount: mergedThreads.length,
  });

  // PR discovery must not delay or multiply the already-expensive working-tree
  // scan. Attach cached metadata now and refresh cache misses after the status
  // response is ready; the callback pushes the resulting metadata over WS.
  const { prByBranch, branchesNeedingPRLookup } = cachedPRs(
    project.path,
    new Set(threadBranchMap.values()),
  );

  const [worktreeResults, localResults] = await Promise.all([
    Promise.allSettled(
      worktreeThreads.map((thread) => worktreeThreadStatus(thread, project.path, statusSpan)),
    ),
    localThreadStatuses(project.path, projectId, localThreads, statusSpan),
  ]);

  statusSpan.end('ok');

  /** Merge PR info into a status object based on the thread's branch. */
  const attachPR = (status: any) => {
    const branch = threadBranchMap.get(status.threadId);
    return branch ? applyPR(status, prByBranch.get(branch)) : status;
  };

  const statuses = [
    ...fulfilledStatuses(worktreeResults),
    ...(await Promise.all(mergedThreads.map((t) => mergedThreadStatus(c, project.path, t)))),
    ...fulfilledStatuses(localResults),
  ].map(attachPR);

  const response = { statuses };
  _gitStatusCache.set(projectId, { data: response, ts: Date.now(), scope: scopeKey });

  schedulePRRefreshes({
    projectPath: project.path,
    userId,
    ghEnv,
    branches: branchesNeedingPRLookup,
    statuses,
    threadBranchMap,
  });

  return response;
}

// GET /api/git/project/:projectId/status
statusRoutes.get('/project/:projectId/status', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const projectId = c.req.param('projectId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  if (!existsSync(cwd)) {
    return resultToResponse(c, err(badRequest(`Working directory does not exist: ${cwd}`)));
  }

  // Background fetch so unpulledCommitCount is fresh on next request. On
  // completion, hint the client to re-fetch the project status (the project-mode
  // slice uses `fetchProjectStatus`, not the WS `git:status` path) so incoming
  // commits surface without a second manual refresh.
  const identity = await resolveIdentity(userId, projectId);
  scheduleBackgroundFetch(projectId, cwd, identity ?? undefined, undefined, () => {
    wsBroker.emitToUser(userId, {
      type: 'git:refs-updated',
      threadId: '',
      data: { projectId },
    });
  });

  const statusSpan = requestSpan(c, 'git.status_summary', { projectId });
  const summaryResult = await getStatusSummary(cwd);
  statusSpan.end(
    summaryResult.isOk() ? 'ok' : 'error',
    summaryResult.isErr() ? summaryResult.error.message : undefined,
  );
  if (summaryResult.isErr()) return resultToResponse(c, summaryResult);
  const summary = summaryResult.value;
  return c.json({
    state: deriveGitSyncState(summary),
    ...summary,
  });
});

// GET /api/git/:threadId/status
statusRoutes.get('/:threadId/status', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  // Steer-share delegation (thread-sharing-steer): a verified `steer` grant
  // authorizes a non-owner sharee for read-only git. The working directory must
  // resolve off the thread OWNER (the checkout lives on their machine), so all
  // project-path lookups below use `pathUserId`. GH_TOKEN still resolves off the
  // SHAREE (`userId`) — a sharee has no token, so PR detection simply degrades;
  // the sharee never borrows the owner's GitHub credentials.
  const steer = steerFromContext(c);
  const threadResult = await requireThread(threadId, userId, steer);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;
  const pathUserId = isSteerGrantFor(threadId, steer) ? thread.userId : userId;

  // Resolve GH_TOKEN for PR detection (off the requester — a sharee has none).
  const identity = await resolveIdentity(userId);
  const ghEnv = identity?.githubToken ? { GH_TOKEN: identity.githubToken } : undefined;
  const branchForPR = thread.branch || thread.baseBranch;

  // Only treat as merged if mergedAt is set (worktree was actually cleaned up
  // after merge). Without this, local-mode threads with branch=null get
  // hardcoded zero stats instead of real git status.
  if (!thread.worktreePath && !thread.branch && thread.baseBranch && thread.mergedAt) {
    const projectResult = await requireProject(thread.projectId, pathUserId, orgId ?? undefined);
    const projectPath = projectResult.isOk() ? projectResult.value.path : null;
    const span = requestSpan(c, 'git.unpushed_count', { threadId, branch: thread.baseBranch });
    const unpushed = projectPath ? await countUnpushedCommits(projectPath, thread.baseBranch) : 0;
    span.end('ok');

    // PR info: synchronous cache hit, otherwise defer and push via WS.
    let prInfo: BranchPRInfo | null | undefined;
    if (projectPath && branchForPR) {
      prInfo = getCachedPR(projectPath, branchForPR);
    }

    const branchKey = computeBranchKey(thread as any);
    const baseStatus = {
      threadId,
      branchKey,
      state: 'merged' as const,
      dirtyFileCount: 0,
      unpushedCommitCount: unpushed,
      unpulledCommitCount: 0,
      hasRemoteBranch: unpushed > 0,
      isMergedIntoBase: true,
      linesAdded: 0,
      linesDeleted: 0,
    };

    if (prInfo === undefined && projectPath && branchForPR) {
      schedulePRLookup({
        projectPath,
        branch: branchForPR,
        ghEnv,
        onUpdate: (pr) =>
          emitPRUpdateForThread({ userId, threadId, branchKey, status: baseStatus, pr }),
      });
    }

    return c.json({
      ...baseStatus,
      ...(prInfo
        ? { prNumber: prInfo.prNumber, prUrl: prInfo.prUrl, prState: prInfo.prState }
        : {}),
    });
  }

  const projectResult = await requireProject(thread.projectId, userId, orgId ?? undefined);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const cwd = thread.worktreePath || project.path;
  const summarySpan = requestSpan(c, 'git.status_summary', { threadId });
  const summaryResult = await getStatusSummary(cwd, thread.baseBranch ?? undefined, project.path);
  summarySpan.end(
    summaryResult.isOk() ? 'ok' : 'error',
    summaryResult.isErr() ? summaryResult.error.message : undefined,
  );
  if (summaryResult.isErr()) return resultToResponse(c, summaryResult);
  const summary = summaryResult.value;

  // PR info: synchronous cache hit, otherwise defer and push via WS.
  const prInfo = branchForPR ? getCachedPR(project.path, branchForPR) : undefined;

  const branchKey = computeBranchKey(thread as any);
  const baseStatus = {
    threadId,
    branchKey,
    state: deriveGitSyncState(summary),
    ...summary,
  };

  // Background fetch so unpulledCommitCount reflects newly-pushed origin commits.
  // The fetch lands AFTER this response; on completion, hint the client to
  // re-fetch through its normal (now cache-fresh) path so the incoming-commit
  // badge surfaces without a second manual refresh. Consistent with the bulk and
  // project routes — the client's `git:refs-updated` handler refetches the active
  // thread, project, and bulk slices, and the store's staleness guard prevents a
  // late stale response from clobbering the fresh one.
  scheduleBackgroundFetch(
    thread.projectId,
    project.path,
    identity ?? undefined,
    { threadId },
    () => {
      wsBroker.emitToUser(userId, {
        type: 'git:refs-updated',
        threadId,
        data: { projectId: thread.projectId },
      });
    },
  );

  if (prInfo === undefined && branchForPR) {
    schedulePRLookup({
      projectPath: project.path,
      branch: branchForPR,
      ghEnv,
      onUpdate: (pr) =>
        emitPRUpdateForThread({ userId, threadId, branchKey, status: baseStatus, pr }),
    });
  }

  return c.json({
    ...baseStatus,
    ...(prInfo ? { prNumber: prInfo.prNumber, prUrl: prInfo.prUrl, prState: prInfo.prState } : {}),
  });
});

function threadScopeKey(scope: Set<string> | null): string {
  return scope ? [...scope].sort().join(',') : '';
}
function filterThreadScope<T extends { id: string }>(threads: T[], scope: Set<string> | null): T[] {
  return scope ? threads.filter((thread) => scope.has(thread.id)) : threads;
}
