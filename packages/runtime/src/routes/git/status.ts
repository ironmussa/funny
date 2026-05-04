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
  getPRForBranch,
  type BranchPRInfo,
} from '@funny/core/git';
import { badRequest } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';

import { startSpan } from '../../lib/telemetry.js';
import { requestSpan } from '../../middleware/tracing.js';
import { resolveIdentity } from '../../services/git-service.js';
import * as tm from '../../services/thread-manager.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { computeBranchKey } from '../../utils/git-status-helpers.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireThread, requireProject } from '../../utils/route-helpers.js';
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

// GET /api/git/status?projectId=xxx — bulk git status for all worktree threads
statusRoutes.get('/status', async (c) => {
  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId required' }, 400);

  // Return cached result if still fresh
  const cached = _gitStatusCache.get(projectId);
  if (cached && Date.now() - cached.ts < GIT_STATUS_CACHE_TTL_MS) {
    return c.json(cached.data);
  }

  const userId = c.get('userId') as string;
  const projectResult = await requireProject(
    projectId,
    userId,
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const { threads } = await tm.listThreads({ projectId, userId });
  const worktreeThreads = threads.filter(
    (t) => t.mode === 'worktree' && t.worktreePath && t.branch,
  );
  // Merged threads: worktree was cleaned up after merge (mergedAt is set).
  // Without the mergedAt check, local-mode threads with branch=null would be
  // incorrectly classified as merged and always receive hardcoded zero stats.
  const mergedThreads = threads.filter(
    (t) => !t.worktreePath && !t.branch && t.baseBranch && t.mergedAt,
  );
  const localThreads = threads.filter(
    (t) => !t.worktreePath && !(!t.branch && t.baseBranch && t.mergedAt),
  );

  // Resolve GH_TOKEN for PR detection (runs once per request)
  const identity = await resolveIdentity(userId);
  const ghEnv = identity?.githubToken ? { GH_TOKEN: identity.githubToken } : undefined;

  // Background fetch: update remote tracking refs so unpulledCommitCount is
  // accurate on the *next* request. Detached so the response isn't blocked
  // by ~1s remote round-trips per project. Throttled per-project; on success
  // the bulk-status cache is invalidated so the next call sees fresh refs.
  scheduleBackgroundFetch(projectId, project.path, identity ?? undefined);

  // Collect unique branches for batch PR lookup (deduplicate across all thread types)
  const uniqueBranches = new Set<string>();
  for (const t of worktreeThreads) if (t.branch) uniqueBranches.add(t.branch);
  for (const t of localThreads) if (t.branch) uniqueBranches.add(t.branch);
  for (const t of mergedThreads) if (t.baseBranch) uniqueBranches.add(t.baseBranch);

  const statusSpan = requestSpan(c, 'git.status.aggregate', {
    projectId,
    worktreeCount: worktreeThreads.length,
    localCount: localThreads.length,
    mergedCount: mergedThreads.length,
  });

  // Run git status + PR lookups in parallel
  const prLookupPromise = (async () => {
    const prByBranch = new Map<
      string,
      { prNumber: number; prUrl: string; prState: 'OPEN' | 'MERGED' | 'CLOSED' }
    >();
    const entries = await Promise.all(
      Array.from(uniqueBranches).map(async (branch) => {
        const span = startSpan('github.pr_lookup', {
          traceId: statusSpan.traceId,
          parentSpanId: statusSpan.spanId,
          attributes: { projectId, branch },
        });
        const pr = await getPRForBranch(project.path, branch, ghEnv);
        span.end('ok');
        return [branch, pr] as const;
      }),
    );
    for (const [branch, pr] of entries) {
      if (pr) prByBranch.set(branch, pr);
    }
    return prByBranch;
  })();

  const [worktreeResults, localResults, prByBranch] = await Promise.all([
    Promise.allSettled(
      worktreeThreads.map(async (thread) => {
        const span = startSpan('git.status_summary', {
          traceId: statusSpan.traceId,
          parentSpanId: statusSpan.spanId,
          attributes: { threadId: thread.id, mode: 'worktree' },
        });
        const summaryResult = await getStatusSummary(
          thread.worktreePath!,
          thread.baseBranch ?? undefined,
          project.path,
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
      }),
    ),
    // Local threads share the project cwd, but only the thread on the
    // currently checked-out branch reflects the working tree. Threads on other
    // branches get committed-only diff stats (git diff base...branch) so they
    // don't inherit the dirty state of whichever branch is checked out now.
    (async () => {
      const currentBranchSpan = startSpan('git.current_branch', {
        traceId: statusSpan.traceId,
        parentSpanId: statusSpan.spanId,
        attributes: { projectId },
      });
      const currentBranchResult = await getCurrentBranch(project.path);
      currentBranchSpan.end(
        currentBranchResult.isOk() ? 'ok' : 'error',
        currentBranchResult.isErr() ? currentBranchResult.error.message : undefined,
      );
      const currentBranch = currentBranchResult.isOk() ? currentBranchResult.value : null;

      // Split threads: those matching the checked-out branch use working-tree
      // summary (shared); others compute committed-only summary per branch.
      const activeThreads: typeof localThreads = [];
      const backgroundThreads: typeof localThreads = [];
      for (const thread of localThreads) {
        if (thread.branch && thread.branch === currentBranch) activeThreads.push(thread);
        else backgroundThreads.push(thread);
      }

      const results: Array<PromiseSettledResult<any>> = [];

      // Active group: one getStatusSummary call shared across all threads on
      // the currently-checked-out branch.
      const activePromise = (async () => {
        if (activeThreads.length === 0) return;
        const representative = activeThreads[0];
        const span = startSpan('git.status_summary', {
          traceId: statusSpan.traceId,
          parentSpanId: statusSpan.spanId,
          attributes: {
            projectId,
            mode: 'local-active',
            threadCount: activeThreads.length,
          },
        });
        const summaryResult = await getStatusSummary(
          project.path,
          representative.baseBranch ?? undefined,
          project.path,
        );
        span.end(
          summaryResult.isOk() ? 'ok' : 'error',
          summaryResult.isErr() ? summaryResult.error.message : undefined,
        );
        if (summaryResult.isErr()) {
          for (const t of activeThreads) {
            results.push({ status: 'fulfilled', value: null });
          }
          return;
        }
        const summary = summaryResult.value;
        const state = deriveGitSyncState(summary);
        for (const t of activeThreads) {
          results.push({
            status: 'fulfilled',
            value: Object.assign(
              { threadId: t.id, branchKey: computeBranchKey(t), state },
              summary,
            ),
          });
        }
      })();

      // Background group: committed-only diff per unique (baseBranch, branch).
      // Threads without a branch or baseBranch are reported with zero stats.
      const bgByKey = new Map<string, typeof localThreads>();
      const bgUnassigned: typeof localThreads = [];
      for (const thread of backgroundThreads) {
        if (!thread.branch || !thread.baseBranch) {
          bgUnassigned.push(thread);
          continue;
        }
        const key = `${thread.baseBranch}..${thread.branch}`;
        const group = bgByKey.get(key);
        if (group) group.push(thread);
        else bgByKey.set(key, [thread]);
      }

      const backgroundPromise = Promise.all(
        Array.from(bgByKey.entries()).map(async ([, threads]) => {
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
          const summaryResult = await getCommittedBranchSummary(
            project.path,
            rep.baseBranch!,
            rep.branch!,
          );
          span.end(
            summaryResult.isOk() ? 'ok' : 'error',
            summaryResult.isErr() ? summaryResult.error.message : undefined,
          );
          if (summaryResult.isErr()) {
            for (const t of threads) {
              results.push({ status: 'fulfilled', value: null });
            }
            return;
          }
          const summary = summaryResult.value;
          const state = deriveGitSyncState(summary);
          for (const t of threads) {
            results.push({
              status: 'fulfilled',
              value: Object.assign(
                { threadId: t.id, branchKey: computeBranchKey(t), state },
                summary,
              ),
            });
          }
        }),
      );

      await Promise.all([activePromise, backgroundPromise]);

      for (const t of bgUnassigned) {
        results.push({
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
        });
      }

      return results;
    })(),
    prLookupPromise,
  ]);

  statusSpan.end('ok');

  /** Merge PR info into a status object based on the thread's branch. */
  function attachPR(status: any, branch?: string | null) {
    if (!branch) return status;
    const pr = prByBranch.get(branch);
    if (pr) {
      status.prNumber = pr.prNumber;
      status.prUrl = pr.prUrl;
      status.prState = pr.prState;
    }
    return status;
  }

  // Map threadId → branch for worktree threads (branch is on the thread object)
  const threadBranchMap = new Map<string, string>();
  for (const t of worktreeThreads) if (t.branch) threadBranchMap.set(t.id, t.branch);
  for (const t of localThreads) if (t.branch) threadBranchMap.set(t.id, t.branch);

  const statuses = [
    ...worktreeResults
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter(Boolean)
      .map((s: any) => attachPR(s, threadBranchMap.get(s.threadId))),
    ...(await Promise.all(
      mergedThreads.map(async (t) => {
        let unpushed = 0;
        if (t.baseBranch) {
          const span = requestSpan(c, 'git.unpushed_count', {
            threadId: t.id,
            branch: t.baseBranch,
          });
          unpushed = await countUnpushedCommits(project.path, t.baseBranch);
          span.end('ok');
        }
        return attachPR(
          {
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
          },
          t.baseBranch,
        );
      }),
    )),
    ...localResults
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter(Boolean)
      .map((s: any) => attachPR(s, threadBranchMap.get(s.threadId))),
  ];

  const response = { statuses };
  _gitStatusCache.set(projectId, { data: response, ts: Date.now() });
  return c.json(response);
});

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

  // Background fetch so unpulledCommitCount is fresh on next request.
  const identity = await resolveIdentity(userId);
  scheduleBackgroundFetch(projectId, cwd, identity ?? undefined);

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
  const threadResult = await requireThread(threadId, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  // Resolve GH_TOKEN for PR detection
  const identity = await resolveIdentity(userId);
  const ghEnv = identity?.githubToken ? { GH_TOKEN: identity.githubToken } : undefined;
  const branchForPR = thread.branch || thread.baseBranch;

  // Only treat as merged if mergedAt is set (worktree was actually cleaned up
  // after merge). Without this, local-mode threads with branch=null get
  // hardcoded zero stats instead of real git status.
  if (!thread.worktreePath && !thread.branch && thread.baseBranch && thread.mergedAt) {
    const projectResult = await requireProject(thread.projectId, userId, orgId ?? undefined);
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

  // Background fetch so unpulledCommitCount is fresh on next request.
  scheduleBackgroundFetch(thread.projectId, project.path, identity ?? undefined, { threadId });

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
