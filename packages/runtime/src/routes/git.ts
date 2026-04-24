/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: GitService
 */

import { existsSync } from 'fs';

import { query } from '@anthropic-ai/claude-agent-sdk';
import { resolveSDKCliPath } from '@funny/core/agents';
import {
  getDiff,
  getDiffSummary,
  getSingleFileDiff,
  getFullContextFileDiff,
  stageFiles,
  unstageFiles,
  stagePatch,
  unstagePatch,
  revertFiles,
  addToGitignore,
  resolveFileConflict,
  commit,
  runHookCommand,
  push,
  pull,
  getStatusSummary,
  getCommittedBranchSummary,
  getCurrentBranch,
  deriveGitSyncState,
  getLog,
  getUnpushedHashes,
  getCommitBody,
  getCommitFiles,
  getCommitFileDiff,
  stash,
  stashFiles,
  stashPop,
  stashDrop,
  stashList,
  stashShow,
  resetSoft,
  fetchRemote,
  git,
  getPRForBranch,
  getRemoteUrl,
  listGitHubOrgs,
  publishRepo,
  setOrigin,
} from '@funny/core/git';
import { badRequest, internal } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err, ok } from 'neverthrow';

import { log } from '../lib/logger.js';
import { startSpan } from '../lib/telemetry.js';
import { requestSpan } from '../middleware/tracing.js';
import {
  stage as gitServiceStage,
  unstage as gitServiceUnstage,
  revert as gitServiceRevert,
  commitChanges as gitServiceCommit,
  pushChanges as gitServicePush,
  pullChanges as gitServicePull,
  stashChanges as gitServiceStash,
  stashSelectedFiles as gitServiceStashFiles,
  popStash as gitServicePopStash,
  dropStash as gitServiceDropStash,
  softReset as gitServiceSoftReset,
  checkoutHash as gitServiceCheckoutHash,
  revertCommit as gitServiceRevertCommit,
  resetHard as gitServiceResetHard,
  merge as gitServiceMerge,
  createPullRequest as gitServiceCreatePR,
  resolveIdentity,
  validateFilePaths,
} from '../services/git-service.js';
import { executeWorkflow, isWorkflowActive } from '../services/git-workflow-service.js';
import { getPipelineForProject } from '../services/pipeline-manager.js';
import {
  buildCommitMessagePrompt,
  COMMIT_MESSAGE_SYSTEM_PROMPT,
} from '../services/pipeline-prompts.js';
import { listHooks } from '../services/project-hooks-service.js';
import * as tm from '../services/thread-manager.js';
import type { HonoEnv } from '../types/hono-env.js';
import { computeBranchKey } from '../utils/git-status-helpers.js';
import { resultToResponse } from '../utils/result-response.js';
import { requireThread, requireThreadCwd, requireProject } from '../utils/route-helpers.js';
import {
  validate,
  mergeSchema,
  stageFilesSchema,
  stagePatchSchema,
  commitSchema,
  createPRSchema,
  workflowSchema,
  publishRepoSchema,
  resolveConflictSchema,
  pullSchema,
  setRemoteSchema,
} from '../validation/schemas.js';

export const gitRoutes = new Hono<HonoEnv>();

// computeBranchKey is imported from utils/git-status-helpers.ts

// In-memory cache for bulk git status to avoid spawning excessive git processes.
const _gitStatusCache = new Map<string, { data: any; ts: number }>();
const GIT_STATUS_CACHE_TTL_MS = 2_000; // 2 seconds

// Throttled fetch: track last fetch time per project so we don't hammer the remote.
const _lastFetchTs = new Map<string, number>();
const FETCH_THROTTLE_MS = 30_000; // 30 seconds

/** Invalidate cached git status for a project after mutating git operations. */
async function invalidateGitStatusCache(threadId: string) {
  const thread = await tm.getThread(threadId);
  if (thread) _gitStatusCache.delete(thread.projectId);
}

/** Invalidate cached git status by project ID directly. Exported for use by event handlers. */
export function invalidateGitStatusCacheByProject(projectId: string) {
  _gitStatusCache.delete(projectId);
}

/** Count unpushed commits on a branch vs its remote tracking branch. */
async function countUnpushedCommits(projectPath: string, branch: string): Promise<number> {
  try {
    const result = await git(['rev-list', '--count', `origin/${branch}..${branch}`], projectPath);
    if (result.isOk()) return parseInt(result.value.trim(), 10) || 0;
  } catch {
    /* remote tracking branch may not exist */
  }
  return 0;
}

/** Count unpulled commits on a branch (commits on origin not yet in local). */
async function countUnpulledCommits(projectPath: string, branch: string): Promise<number> {
  try {
    const result = await git(['rev-list', '--count', `${branch}..origin/${branch}`], projectPath);
    if (result.isOk()) return parseInt(result.value.trim(), 10) || 0;
  } catch {
    /* remote tracking branch may not exist */
  }
  return 0;
}

/** Resolve project path from projectId and verify ownership. */
async function requireProjectCwd(
  projectId: string,
  userId?: string,
  organizationId?: string,
): Promise<import('neverthrow').Result<string, import('@funny/shared/errors').DomainError>> {
  const projectResult = await requireProject(projectId, userId, organizationId);
  if (projectResult.isErr()) return projectResult.map(() => '');
  return ok(projectResult.value.path);
}

// ═══════════════════════════════════════════════════════════════════════════
// Bulk git status
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/git/status?projectId=xxx — bulk git status for all worktree threads
gitRoutes.get('/status', async (c) => {
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

  // Throttled fetch: update remote tracking refs so unpulledCommitCount is accurate.
  // Runs at most once every FETCH_THROTTLE_MS per project (non-blocking on failure).
  const lastFetch = _lastFetchTs.get(projectId) ?? 0;
  if (Date.now() - lastFetch > FETCH_THROTTLE_MS) {
    _lastFetchTs.set(projectId, Date.now());
    const fetchSpan = requestSpan(c, 'git.fetch_remote', { projectId });
    await fetchRemote(project.path, identity ?? undefined).match(
      () => fetchSpan.end('ok'),
      () => fetchSpan.end('error'),
    );
  }

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
            branchKey: computeBranchKey(thread),
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

// ═══════════════════════════════════════════════════════════════════════════
// Project-based git routes — operate on a project's main directory directly,
// without requiring a thread. Used by the ReviewPane when no thread is active.
// IMPORTANT: These must be registered BEFORE /:threadId routes so that
// "/project/:projectId/..." is not captured by "/:threadId/...".
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/git/project/:projectId/status
gitRoutes.get('/project/:projectId/status', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const projectId = c.req.param('projectId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  if (!existsSync(cwd)) {
    return resultToResponse(c, err(badRequest(`Working directory does not exist: ${cwd}`)));
  }

  // Throttled fetch so unpulledCommitCount is accurate
  const lastFetch = _lastFetchTs.get(projectId) ?? 0;
  if (Date.now() - lastFetch > FETCH_THROTTLE_MS) {
    _lastFetchTs.set(projectId, Date.now());
    const fetchSpan = requestSpan(c, 'git.fetch_remote', { projectId });
    const identity = await resolveIdentity(userId);
    await fetchRemote(cwd, identity ?? undefined).match(
      () => fetchSpan.end('ok'),
      () => fetchSpan.end('error'),
    );
  }

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

// GET /api/git/project/:projectId/diff/summary
gitRoutes.get('/project/:projectId/diff/summary', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  if (!existsSync(cwd)) {
    return resultToResponse(c, err(badRequest(`Working directory does not exist: ${cwd}`)));
  }
  const excludeRaw = c.req.query('exclude');
  const excludePatterns = excludeRaw
    ? excludeRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const maxFilesRaw = c.req.query('maxFiles');
  const maxFiles = maxFilesRaw ? parseInt(maxFilesRaw, 10) : undefined;
  const projectId = c.req.param('projectId');
  const span = requestSpan(c, 'git.diff_summary', { projectId });
  const result = await getDiffSummary(cwd, { excludePatterns, maxFiles });
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json(result.value);
});

// GET /api/git/project/:projectId/diff/submodule
gitRoutes.get('/project/:projectId/diff/submodule', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const relPath = c.req.query('path');
  if (!relPath) {
    return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
  }
  const pathCheck = validateFilePaths(cwd, [relPath]);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
  const { join } = await import('node:path');
  const submoduleCwd = join(cwd, relPath);
  if (!existsSync(submoduleCwd) || !existsSync(join(submoduleCwd, '.git'))) {
    return resultToResponse(c, err(badRequest(`Not a git repository: ${relPath}`)));
  }
  const span = requestSpan(c, 'git.diff_submodule', {
    projectId: c.req.param('projectId'),
    path: relPath,
  });
  const result = await getDiffSummary(submoduleCwd);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json(result.value);
});

// GET /api/git/project/:projectId/diff/file
gitRoutes.get('/project/:projectId/diff/file', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const filePath = c.req.query('path');
  if (!filePath) {
    return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
  }
  const staged = c.req.query('staged') === 'true';
  const fullContext = c.req.query('context') === 'full';
  const span = requestSpan(c, 'git.diff_file', {
    projectId: c.req.param('projectId'),
    path: filePath,
    fullContext,
  });
  const result = fullContext
    ? await getFullContextFileDiff(cwd, filePath, staged)
    : await getSingleFileDiff(cwd, filePath, staged);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ diff: result.value });
});

// GET /api/git/project/:projectId/log
gitRoutes.get('/project/:projectId/log', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 20, 200) : 50;
  const skipRaw = c.req.query('skip');
  const skip = skipRaw ? Math.max(parseInt(skipRaw, 10) || 0, 0) : 0;
  const cwd = cwdResult.value;
  const projectId = c.req.param('projectId');
  const [result, unpushedResult] = await Promise.all([
    (async () => {
      const span = requestSpan(c, 'git.log', { projectId });
      const r = await getLog(cwd, limit + 1, undefined, skip);
      span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
      return r;
    })(),
    (async () => {
      const span = requestSpan(c, 'git.unpushed_hashes', { projectId });
      const r = await getUnpushedHashes(cwd);
      span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
      return r;
    })(),
  ]);
  if (result.isErr()) return resultToResponse(c, result);
  const entries = result.value;
  const hasMore = entries.length > limit;
  const unpushedSet = unpushedResult.isOk() ? unpushedResult.value : new Set<string>();
  const trimmed = hasMore ? entries.slice(0, limit) : entries;
  const unpushedHashes = trimmed.filter((e) => unpushedSet.has(e.hash)).map((e) => e.hash);
  return c.json({ entries: trimmed, hasMore, unpushedHashes });
});

// GET /api/git/project/:projectId/commit/:hash/files
gitRoutes.get('/project/:projectId/commit/:hash/files', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const span = requestSpan(c, 'git.commit_files', {
    projectId: c.req.param('projectId'),
    hash: c.req.param('hash'),
  });
  const result = await getCommitFiles(cwdResult.value, c.req.param('hash'));
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ files: result.value });
});

// GET /api/git/project/:projectId/commit/:hash/diff
gitRoutes.get('/project/:projectId/commit/:hash/diff', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const filePath = c.req.query('path');
  if (!filePath) {
    return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
  }
  const span = requestSpan(c, 'git.commit_diff', {
    projectId: c.req.param('projectId'),
    hash: c.req.param('hash'),
    path: filePath,
  });
  const result = await getCommitFileDiff(cwdResult.value, c.req.param('hash'), filePath);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ diff: result.value });
});

// GET /api/git/project/:projectId/commit/:hash/body
gitRoutes.get('/project/:projectId/commit/:hash/body', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const span = requestSpan(c, 'git.commit_body', {
    projectId: c.req.param('projectId'),
    hash: c.req.param('hash'),
  });
  const result = await getCommitBody(cwdResult.value, c.req.param('hash'));
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ body: result.value });
});

// GET /api/git/project/:projectId/stash/list
gitRoutes.get('/project/:projectId/stash/list', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const span = requestSpan(c, 'git.stash_list', { projectId: c.req.param('projectId') });
  const result = await stashList(cwdResult.value);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ entries: result.value });
});

// GET /api/git/project/:projectId/stash/show/:stashIndex
gitRoutes.get('/project/:projectId/stash/show/:stashIndex', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const stashRef = `stash@{${c.req.param('stashIndex')}}`;
  const span = requestSpan(c, 'git.stash_show', {
    projectId: c.req.param('projectId'),
    stashIndex: c.req.param('stashIndex'),
  });
  const result = await stashShow(cwdResult.value, stashRef);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ files: result.value });
});

// POST /api/git/project/:projectId/stage
gitRoutes.post('/project/:projectId/stage', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const pathCheck = validateFilePaths(cwd, parsed.value.paths);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
  const result = await stageFiles(cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true });
});

// POST /api/git/project/:projectId/unstage
gitRoutes.post('/project/:projectId/unstage', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const pathCheck = validateFilePaths(cwd, parsed.value.paths);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
  const result = await unstageFiles(cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true });
});

// POST /api/git/project/:projectId/stage-patch — partial (line-level) staging
gitRoutes.post('/project/:projectId/stage-patch', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stagePatchSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const result = await stagePatch(cwd, parsed.value.patch);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true });
});

// POST /api/git/project/:projectId/unstage-patch — partial (line-level) unstaging
gitRoutes.post('/project/:projectId/unstage-patch', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stagePatchSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const result = await unstagePatch(cwd, parsed.value.patch);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true });
});

// POST /api/git/project/:projectId/revert
gitRoutes.post('/project/:projectId/revert', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const pathCheck = validateFilePaths(cwd, parsed.value.paths);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
  const result = await revertFiles(cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true });
});

// POST /api/git/project/:projectId/checkout-commit
gitRoutes.post('/project/:projectId/checkout-commit', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const { hash } = await c.req.json().catch(() => ({}));
  if (!hash) return c.json({ error: 'hash is required' }, 400);

  const result = await gitServiceCheckoutHash(projectId, userId, cwdResult.value, hash);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/revert-commit
gitRoutes.post('/project/:projectId/revert-commit', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const { hash } = await c.req.json().catch(() => ({}));
  if (!hash) return c.json({ error: 'hash is required' }, 400);

  const result = await gitServiceRevertCommit(projectId, userId, cwdResult.value, hash);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/reset-hard
gitRoutes.post('/project/:projectId/reset-hard', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const { hash } = await c.req.json().catch(() => ({}));
  if (!hash) return c.json({ error: 'hash is required' }, 400);

  const result = await gitServiceResetHard(projectId, userId, cwdResult.value, hash);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/conflict/resolve
gitRoutes.post('/project/:projectId/conflict/resolve', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(resolveConflictSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const pathCheck = validateFilePaths(cwd, [parsed.value.filePath]);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
  const result = await resolveFileConflict(
    cwd,
    parsed.value.filePath,
    parsed.value.blockIndex,
    parsed.value.resolution,
  );
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, remainingConflicts: result.value.remainingConflicts });
});

// POST /api/git/project/:projectId/commit
gitRoutes.post('/project/:projectId/commit', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(commitSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const identity = await resolveIdentity(userId);
  const result = await commit(
    cwd,
    parsed.value.message,
    identity,
    parsed.value.amend,
    parsed.value.noVerify,
  );
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/run-hook-command
// Runs a single pre-commit hook command by index for per-hook progress tracking
gitRoutes.post('/project/:projectId/run-hook-command', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const hookIndex = raw?.hookIndex;
  if (typeof hookIndex !== 'number') {
    return resultToResponse(c, err(badRequest('hookIndex is required')));
  }
  const hooks = listHooks(cwd, 'pre-commit').filter((h) => h.enabled);
  if (hookIndex < 0 || hookIndex >= hooks.length) {
    return resultToResponse(c, err(badRequest(`Invalid hookIndex: ${hookIndex}`)));
  }
  const hookResult = await runHookCommand(cwd, hooks[hookIndex].command);
  if (hookResult.isErr()) return resultToResponse(c, hookResult);
  return c.json(hookResult.value);
});

// POST /api/git/project/:projectId/push
gitRoutes.post('/project/:projectId/push', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const identity = await resolveIdentity(userId);
  const result = await push(cwdResult.value, identity);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// GET /api/git/project/:projectId/remote-url
gitRoutes.get('/project/:projectId/remote-url', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const span = requestSpan(c, 'git.remote_url', { projectId });
  const result = await getRemoteUrl(cwdResult.value);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ remoteUrl: result.value });
});

// POST /api/git/project/:projectId/remote
// Add or update the `origin` remote for a project that was initialized
// locally with no remote configured (GitHub Desktop-style "add remote").
gitRoutes.post('/project/:projectId/remote', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const parsed = validate(setRemoteSchema, await c.req.json().catch(() => ({})));
  if (parsed.isErr()) return resultToResponse(c, parsed);
  log.info('git.setOrigin', { namespace: 'git', projectId });
  const result = await setOrigin(cwdResult.value, parsed.value.url);
  if (result.isErr()) {
    log.error('git.setOrigin.failed', {
      namespace: 'git',
      projectId,
      error: String(result.error),
    });
    return resultToResponse(c, result);
  }
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true });
});

// GET /api/git/project/:projectId/gh-orgs
gitRoutes.get('/project/:projectId/gh-orgs', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const identity = await resolveIdentity(userId);
  if (!identity?.githubToken) {
    return c.json({ orgs: [] });
  }
  const span = requestSpan(c, 'github.orgs', { projectId });
  const result = await listGitHubOrgs(cwdResult.value, { GH_TOKEN: identity.githubToken });
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ orgs: result.value });
});

// POST /api/git/project/:projectId/publish
gitRoutes.post('/project/:projectId/publish', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const identity = await resolveIdentity(userId);
  if (!identity?.githubToken) {
    return c.json({ error: 'GitHub token required. Set one in Settings > Profile.' }, 400);
  }
  const parsed = validate(publishRepoSchema, await c.req.json());
  if (parsed.isErr()) return resultToResponse(c, parsed);
  log.info('git.publish', { namespace: 'git', projectId, repoName: parsed.value.name });
  const result = await publishRepo(cwdResult.value, parsed.value, {
    GH_TOKEN: identity.githubToken,
  });
  if (result.isErr()) {
    log.error('git.publish.failed', { namespace: 'git', projectId, error: String(result.error) });
    return resultToResponse(c, result);
  }
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, repoUrl: result.value });
});

// POST /api/git/project/:projectId/pull
gitRoutes.post('/project/:projectId/pull', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(pullSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const identity = await resolveIdentity(userId);
  const result = await pull(cwdResult.value, parsed.value.strategy, identity);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/fetch
gitRoutes.post('/project/:projectId/fetch', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const identity = await resolveIdentity(userId);
  const result = await fetchRemote(cwdResult.value, identity);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true });
});

// POST /api/git/project/:projectId/stash
gitRoutes.post('/project/:projectId/stash', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const body = await c.req.json().catch(() => ({}));
  const files = Array.isArray(body.files) ? body.files : [];
  const result =
    files.length > 0 ? await stashFiles(cwdResult.value, files) : await stash(cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/stash/pop
gitRoutes.post('/project/:projectId/stash/pop', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const result = await stashPop(cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/stash/drop/:stashIndex
gitRoutes.post('/project/:projectId/stash/drop/:stashIndex', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const stashIndex = parseInt(c.req.param('stashIndex'), 10);
  if (Number.isNaN(stashIndex) || stashIndex < 0) {
    return resultToResponse(c, err(badRequest('Invalid stash index')));
  }
  const result = await stashDrop(cwdResult.value, stashIndex);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/reset-soft
gitRoutes.post('/project/:projectId/reset-soft', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const result = await resetSoft(cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/generate-commit-message
gitRoutes.post('/project/:projectId/generate-commit-message', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const projectId = c.req.param('projectId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const body = await c.req.json().catch(() => ({}));
  const includeUnstaged = body?.includeUnstaged === true;

  const diffResult = await getDiff(cwd);
  if (diffResult.isErr()) return resultToResponse(c, diffResult);
  const diffs = diffResult.value;
  const relevantDiffs = includeUnstaged ? diffs : diffs.filter((d) => d.staged);

  if (relevantDiffs.length === 0) {
    return resultToResponse(c, err(badRequest('No files to generate a commit message for')));
  }

  let diffSummary = relevantDiffs
    .map((d) => `--- ${d.status}: ${d.path} ---\n${d.diff || '(no diff)'}`)
    .join('\n\n');

  const MAX_DIFF_LEN = 20_000;
  if (diffSummary.length > MAX_DIFF_LEN) {
    diffSummary = diffSummary.slice(0, MAX_DIFF_LEN) + '\n\n... (diff truncated for length)';
  }

  const pipelineCfg = getPipelineForProject(projectId);
  const prompt = buildCommitMessagePrompt(diffSummary, pipelineCfg?.commitMessagePrompt);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  const output = await (async (): Promise<{ text: string } | { error: string }> => {
    try {
      let resultText = '';

      const gen = query({
        prompt,
        options: {
          cwd,
          maxTurns: 1,
          permissionMode: 'plan',
          abortController: controller,
          pathToClaudeCodeExecutable: resolveSDKCliPath(),
          systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
          tools: [],
        },
      });

      for await (const msg of gen) {
        if (msg.type === 'assistant') {
          const content = (msg as any).message?.content;
          if (!content) continue;
          const text = content
            .filter((b: any) => b.type === 'text' && b.text)
            .map((b: any) => b.text)
            .join('\n');
          if (text) resultText = text;
        }
        if (msg.type === 'result') {
          const r = (msg as any).result || resultText;
          return r ? { text: r } : { error: 'No output received' };
        }
      }

      return resultText ? { text: resultText } : { error: 'No output received' };
    } catch (e: any) {
      log.error('SDK query error generating commit message', {
        namespace: 'git',
        error: e.message,
      });
      return { error: e.message || 'Unknown error' };
    } finally {
      clearTimeout(timeout);
    }
  })();

  if ('error' in output) {
    return resultToResponse(c, err(internal(output.error)));
  }

  const trimmed = output.text.trim();
  const errorPatterns = [
    /invalid api key/i,
    /authentication.*error/i,
    /fix external api key/i,
    /unauthorized/i,
    /api key.*invalid/i,
  ];
  if (errorPatterns.some((p) => p.test(trimmed))) {
    log.error('SDK auth error generating commit message', {
      namespace: 'git',
      output: trimmed.slice(0, 200),
    });
    return resultToResponse(c, err(internal(trimmed.split('\n')[0])));
  }

  const titleMatch = trimmed.match(/^TITLE:\s*(.+)/m);
  const bodyMatch = trimmed.match(/^BODY:\s*([\s\S]+)/m);

  if (!titleMatch) {
    log.error('Unexpected output from commit message generation', {
      namespace: 'git',
      output: trimmed.slice(0, 500),
    });
    return resultToResponse(c, err(internal('Failed to generate commit message')));
  }

  const title = titleMatch[1].trim();
  const commitBody = bodyMatch?.[1]?.trim() || '';

  return c.json({ title, body: commitBody });
});

// POST /api/git/project/:projectId/gitignore
gitRoutes.post('/project/:projectId/gitignore', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const patterns: string[] = Array.isArray(raw?.patterns)
    ? raw.patterns.filter((p: unknown) => typeof p === 'string' && p)
    : typeof raw?.pattern === 'string' && raw.pattern
      ? [raw.pattern]
      : [];
  if (patterns.length === 0) {
    return c.json({ error: 'pattern or patterns is required' }, 400);
  }
  for (const p of patterns) {
    const result = addToGitignore(cwd, p);
    if (result.isErr()) return resultToResponse(c, result);
  }
  return c.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════
// Thread-scoped git routes — delegate to GitService for event emission
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/git/:threadId/status
gitRoutes.get('/:threadId/status', async (c) => {
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
    const [unpushed, prInfo] = await Promise.all([
      (async () => {
        if (!projectPath) return 0;
        const span = requestSpan(c, 'git.unpushed_count', { threadId, branch: thread.baseBranch });
        const r = await countUnpushedCommits(projectPath, thread.baseBranch);
        span.end('ok');
        return r;
      })(),
      (async () => {
        if (!projectPath || !branchForPR) return null;
        const span = requestSpan(c, 'github.pr_lookup', { threadId, branch: branchForPR });
        const r = await getPRForBranch(projectPath, branchForPR, ghEnv);
        span.end('ok');
        return r;
      })(),
    ]);
    return c.json({
      threadId,
      branchKey: computeBranchKey(thread),
      state: 'merged' as const,
      dirtyFileCount: 0,
      unpushedCommitCount: unpushed,
      unpulledCommitCount: 0,
      hasRemoteBranch: unpushed > 0,
      isMergedIntoBase: true,
      linesAdded: 0,
      linesDeleted: 0,
      ...(prInfo
        ? { prNumber: prInfo.prNumber, prUrl: prInfo.prUrl, prState: prInfo.prState }
        : {}),
    });
  }

  const projectResult = await requireProject(thread.projectId, userId, orgId ?? undefined);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  // Throttled fetch: update remote tracking refs so unpulledCommitCount is accurate.
  const lastFetch = _lastFetchTs.get(thread.projectId) ?? 0;
  if (Date.now() - lastFetch > FETCH_THROTTLE_MS) {
    _lastFetchTs.set(thread.projectId, Date.now());
    const fetchSpan = requestSpan(c, 'git.fetch_remote', { threadId });
    await fetchRemote(project.path, identity ?? undefined).match(
      () => fetchSpan.end('ok'),
      () => fetchSpan.end('error'),
    );
  }

  const cwd = thread.worktreePath || project.path;
  const [summaryResult, prInfo] = await Promise.all([
    (async () => {
      const span = requestSpan(c, 'git.status_summary', { threadId });
      const r = await getStatusSummary(cwd, thread.baseBranch ?? undefined, project.path);
      span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
      return r;
    })(),
    (async () => {
      if (!branchForPR) return null;
      const span = requestSpan(c, 'github.pr_lookup', { threadId, branch: branchForPR });
      const r = await getPRForBranch(project.path, branchForPR, ghEnv);
      span.end('ok');
      return r;
    })(),
  ]);
  if (summaryResult.isErr()) return resultToResponse(c, summaryResult);
  const summary = summaryResult.value;

  return c.json({
    threadId,
    branchKey: computeBranchKey(thread),
    state: deriveGitSyncState(summary),
    ...summary,
    ...(prInfo ? { prNumber: prInfo.prNumber, prUrl: prInfo.prUrl, prState: prInfo.prState } : {}),
  });
});

// GET /api/git/:threadId/diff/summary
gitRoutes.get('/:threadId/diff/summary', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  if (!existsSync(cwd)) {
    return resultToResponse(c, err(badRequest(`Working directory does not exist: ${cwd}`)));
  }
  const excludeRaw = c.req.query('exclude');
  const excludePatterns = excludeRaw
    ? excludeRaw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const maxFilesRaw = c.req.query('maxFiles');
  const maxFiles = maxFilesRaw ? parseInt(maxFilesRaw, 10) : undefined;
  const span = requestSpan(c, 'git.diff_summary', { threadId: c.req.param('threadId') });
  const result = await getDiffSummary(cwd, { excludePatterns, maxFiles });
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json(result.value);
});

// GET /api/git/:threadId/diff/submodule
// Returns a diff summary for the inside of a submodule / nested git repo,
// scoped by the submodule's path relative to the thread cwd.
gitRoutes.get('/:threadId/diff/submodule', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const relPath = c.req.query('path');
  if (!relPath) {
    return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
  }
  const pathCheck = validateFilePaths(cwd, [relPath]);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
  const { join } = await import('node:path');
  const submoduleCwd = join(cwd, relPath);
  if (!existsSync(submoduleCwd) || !existsSync(join(submoduleCwd, '.git'))) {
    return resultToResponse(c, err(badRequest(`Not a git repository: ${relPath}`)));
  }
  const span = requestSpan(c, 'git.diff_submodule', {
    threadId: c.req.param('threadId'),
    path: relPath,
  });
  const result = await getDiffSummary(submoduleCwd);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json(result.value);
});

// GET /api/git/:threadId/diff/file
gitRoutes.get('/:threadId/diff/file', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const filePath = c.req.query('path');
  if (!filePath) {
    return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
  }
  const staged = c.req.query('staged') === 'true';
  const fullContext = c.req.query('context') === 'full';
  const span = requestSpan(c, 'git.diff_file', {
    threadId: c.req.param('threadId'),
    path: filePath,
    fullContext,
  });
  const result = fullContext
    ? await getFullContextFileDiff(cwd, filePath, staged)
    : await getSingleFileDiff(cwd, filePath, staged);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ diff: result.value });
});

// GET /api/git/:threadId/diff
gitRoutes.get('/:threadId/diff', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  if (!existsSync(cwd)) {
    return resultToResponse(c, err(badRequest(`Working directory does not exist: ${cwd}`)));
  }
  const span = requestSpan(c, 'git.diff', { threadId: c.req.param('threadId') });
  const diffResult = await getDiff(cwd);
  span.end(
    diffResult.isOk() ? 'ok' : 'error',
    diffResult.isErr() ? diffResult.error.message : undefined,
  );
  if (diffResult.isErr()) return resultToResponse(c, diffResult);
  return c.json(diffResult.value);
});

// POST /api/git/:threadId/stage
gitRoutes.post('/:threadId/stage', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const pathCheck = validateFilePaths(cwd, parsed.value.paths);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);

  const result = await gitServiceStage(threadId, userId, cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);

  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/unstage
gitRoutes.post('/:threadId/unstage', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const pathCheck = validateFilePaths(cwd, parsed.value.paths);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);

  const result = await gitServiceUnstage(threadId, userId, cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);

  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/stage-patch — partial (line-level) staging
gitRoutes.post('/:threadId/stage-patch', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stagePatchSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const result = await stagePatch(cwd, parsed.value.patch);
  if (result.isErr()) return resultToResponse(c, result);

  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/unstage-patch — partial (line-level) unstaging
gitRoutes.post('/:threadId/unstage-patch', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stagePatchSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const result = await unstagePatch(cwd, parsed.value.patch);
  if (result.isErr()) return resultToResponse(c, result);

  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/revert
gitRoutes.post('/:threadId/revert', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const pathCheck = validateFilePaths(cwd, parsed.value.paths);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);

  const result = await gitServiceRevert(threadId, userId, cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);

  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/conflict/resolve
gitRoutes.post('/:threadId/conflict/resolve', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(resolveConflictSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const pathCheck = validateFilePaths(cwd, [parsed.value.filePath]);
  if (pathCheck.isErr()) return resultToResponse(c, pathCheck);

  const result = await resolveFileConflict(
    cwd,
    parsed.value.filePath,
    parsed.value.blockIndex,
    parsed.value.resolution,
  );
  if (result.isErr()) return resultToResponse(c, result);

  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, remainingConflicts: result.value.remainingConflicts });
});

// POST /api/git/:threadId/commit
gitRoutes.post('/:threadId/commit', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(commitSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const span = requestSpan(c, 'git.commit', { threadId });
  const result = await gitServiceCommit(
    threadId,
    userId,
    cwd,
    parsed.value.message,
    parsed.value.amend,
    parsed.value.noVerify,
  );
  if (result.isErr()) {
    span.end('error', result.error.message);
    return resultToResponse(c, result);
  }
  await invalidateGitStatusCache(threadId);
  span.end('ok');
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/run-hook-command
// Runs a single pre-commit hook command by index for per-hook progress tracking
gitRoutes.post('/:threadId/run-hook-command', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const raw = await c.req.json().catch(() => ({}));
  const hookIndex = raw?.hookIndex;
  if (typeof hookIndex !== 'number') {
    return resultToResponse(c, err(badRequest('hookIndex is required')));
  }
  // Look up the project path for hook config (worktree cwd may differ from project root)
  const thread = await tm.getThread(threadId);
  const projectId = thread?.projectId;
  let hookCwd = cwd;
  if (projectId) {
    const project = await requireProject(projectId, userId, orgId);
    if (project.isOk()) hookCwd = project.value.path;
  }
  const hooks = listHooks(hookCwd, 'pre-commit').filter((h) => h.enabled);
  if (hookIndex < 0 || hookIndex >= hooks.length) {
    return resultToResponse(c, err(badRequest(`Invalid hookIndex: ${hookIndex}`)));
  }
  // Run the hook command in the thread's working directory (not the project root)
  const hookResult = await runHookCommand(cwd, hooks[hookIndex].command);
  if (hookResult.isErr()) return resultToResponse(c, hookResult);
  return c.json(hookResult.value);
});

// POST /api/git/:threadId/push
gitRoutes.post('/:threadId/push', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const span = requestSpan(c, 'git.push', { threadId });
  const result = await gitServicePush(threadId, userId, cwdResult.value);
  if (result.isErr()) {
    span.end('error', result.error.message);
    return resultToResponse(c, result);
  }
  await invalidateGitStatusCache(threadId);
  span.end('ok');
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/pr
gitRoutes.post('/:threadId/pr', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(createPRSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const span = requestSpan(c, 'git.create_pr', { threadId });
  const result = await gitServiceCreatePR({
    threadId,
    userId,
    cwd: cwdResult.value,
    title: parsed.value.title,
    body: parsed.value.body,
  });
  if (result.isErr()) {
    span.end('error', result.error.message);
    return resultToResponse(c, result);
  }
  span.end('ok');
  return c.json({ ok: true, url: result.value });
});

// POST /api/git/:threadId/generate-commit-message
gitRoutes.post('/:threadId/generate-commit-message', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const threadId = c.req.param('threadId');
  const threadResult = await requireThread(threadId, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const body = await c.req.json().catch(() => ({}));
  const includeUnstaged = body?.includeUnstaged === true;

  const diffResult = await getDiff(cwd);
  if (diffResult.isErr()) return resultToResponse(c, diffResult);
  const diffs = diffResult.value;
  const relevantDiffs = includeUnstaged ? diffs : diffs.filter((d) => d.staged);

  if (relevantDiffs.length === 0) {
    return resultToResponse(c, err(badRequest('No files to generate a commit message for')));
  }

  let diffSummary = relevantDiffs
    .map((d) => `--- ${d.status}: ${d.path} ---\n${d.diff || '(no diff)'}`)
    .join('\n\n');

  const MAX_DIFF_LEN = 20_000;
  if (diffSummary.length > MAX_DIFF_LEN) {
    diffSummary = diffSummary.slice(0, MAX_DIFF_LEN) + '\n\n... (diff truncated for length)';
  }

  const pipelineCfg = await getPipelineForProject(thread.projectId);
  const prompt = buildCommitMessagePrompt(diffSummary, pipelineCfg?.commitMessagePrompt);

  const span = requestSpan(c, 'ai.generate_commit_message', {
    diffLength: diffSummary.length,
    fileCount: relevantDiffs.length,
  });

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);

  const output = await (async (): Promise<{ text: string } | { error: string }> => {
    try {
      let resultText = '';

      const gen = query({
        prompt,
        options: {
          cwd,
          maxTurns: 1,
          permissionMode: 'plan',
          abortController: controller,
          pathToClaudeCodeExecutable: resolveSDKCliPath(),
          systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
          tools: [],
        },
      });

      for await (const msg of gen) {
        if (msg.type === 'assistant') {
          const content = (msg as any).message?.content;
          if (!content) continue;
          const text = content
            .filter((b: any) => b.type === 'text' && b.text)
            .map((b: any) => b.text)
            .join('\n');
          if (text) resultText = text;
        }
        if (msg.type === 'result') {
          const r = (msg as any).result || resultText;
          return r ? { text: r } : { error: 'No output received' };
        }
      }

      return resultText ? { text: resultText } : { error: 'No output received' };
    } catch (e: any) {
      log.error('SDK query error generating commit message', {
        namespace: 'git',
        error: e.message,
      });
      return { error: e.message || 'Unknown error' };
    } finally {
      clearTimeout(timeout);
    }
  })();

  if ('error' in output) {
    span.end('error', output.error);
    return resultToResponse(c, err(internal(output.error)));
  }

  span.end('ok');

  const trimmed = output.text.trim();
  const errorPatterns = [
    /invalid api key/i,
    /authentication.*error/i,
    /fix external api key/i,
    /unauthorized/i,
    /api key.*invalid/i,
  ];
  if (errorPatterns.some((p) => p.test(trimmed))) {
    log.error('SDK auth error generating commit message', {
      namespace: 'git',
      output: trimmed.slice(0, 200),
    });
    return resultToResponse(c, err(internal(trimmed.split('\n')[0])));
  }

  const titleMatch = trimmed.match(/^TITLE:\s*(.+)/m);
  const bodyMatch = trimmed.match(/^BODY:\s*([\s\S]+)/m);

  if (!titleMatch) {
    log.error('Unexpected output from commit message generation', {
      namespace: 'git',
      output: trimmed.slice(0, 500),
    });
    return resultToResponse(c, err(internal('Failed to generate commit message')));
  }

  const title = titleMatch[1].trim();
  const commitBody = bodyMatch?.[1]?.trim() || '';

  return c.json({ title, body: commitBody });
});

// POST /api/git/:threadId/merge
gitRoutes.post('/:threadId/merge', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const threadResult = await requireThread(threadId, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(mergeSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const span = requestSpan(c, 'git.merge', {
    threadId,
    targetBranch: parsed.value.targetBranch,
  });
  const result = await gitServiceMerge({
    threadId,
    userId,
    targetBranch: parsed.value.targetBranch,
    push: parsed.value.push,
    cleanup: parsed.value.cleanup,
  });
  if (result.isErr()) {
    span.end('error', result.error.message);
    return resultToResponse(c, result);
  }
  await invalidateGitStatusCache(threadId);
  span.end('ok');
  return c.json({ ok: true, output: result.value });
});

// ═══════════════════════════════════════════════════════════════════════════
// Server-side workflow orchestration
// ═══════════════════════════════════════════════════════════════════════════

// POST /api/git/:threadId/workflow — orchestrate multi-step git workflow
gitRoutes.post('/:threadId/workflow', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const threadResult = await requireThread(threadId, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(workflowSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  // Validate file paths
  const allPaths = [...(parsed.value.filesToStage || []), ...(parsed.value.filesToUnstage || [])];
  if (allPaths.length > 0) {
    const pathCheck = validateFilePaths(cwdResult.value, allPaths);
    if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
  }

  if (isWorkflowActive(threadId)) {
    return c.json({ error: 'A workflow is already in progress' }, 409);
  }

  try {
    const { workflowId } = executeWorkflow({
      contextId: threadId,
      threadId,
      projectId: thread.projectId,
      userId,
      cwd: cwdResult.value,
      ...parsed.value,
    });
    return c.json({ workflowId }, 202);
  } catch (e: any) {
    return resultToResponse(c, err(internal(e.message)));
  }
});

// POST /api/git/project/:projectId/workflow — project-scoped workflow
gitRoutes.post('/project/:projectId/workflow', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(workflowSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  // Validate: merge/PR not supported in project mode
  if (['commit-merge', 'merge', 'commit-pr', 'create-pr'].includes(parsed.value.action)) {
    return c.json({ error: `Action "${parsed.value.action}" requires a thread` }, 400);
  }

  // Validate file paths
  const allPaths = [...(parsed.value.filesToStage || []), ...(parsed.value.filesToUnstage || [])];
  if (allPaths.length > 0) {
    const pathCheck = validateFilePaths(cwdResult.value, allPaths);
    if (pathCheck.isErr()) return resultToResponse(c, pathCheck);
  }

  if (isWorkflowActive(projectId)) {
    return c.json({ error: 'A workflow is already in progress' }, 409);
  }

  try {
    const { workflowId } = executeWorkflow({
      contextId: projectId,
      projectId,
      userId,
      cwd: cwdResult.value,
      ...parsed.value,
    });
    return c.json({ workflowId }, 202);
  } catch (e: any) {
    return resultToResponse(c, err(internal(e.message)));
  }
});

// GET /api/git/:threadId/log
gitRoutes.get('/:threadId/log', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const threadId = c.req.param('threadId');
  const threadResult = await requireThread(threadId, userId, orgId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 20, 200) : 50;
  const skipRaw = c.req.query('skip');
  const skip = skipRaw ? Math.max(parseInt(skipRaw, 10) || 0, 0) : 0;

  const all = c.req.query('all') === 'true';
  const baseBranch = all ? undefined : thread.baseBranch;
  const cwd = cwdResult.value;
  const [result, unpushedResult] = await Promise.all([
    (async () => {
      const span = requestSpan(c, 'git.log', { threadId });
      const r = await getLog(cwd, limit + 1, baseBranch, skip);
      span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
      return r;
    })(),
    (async () => {
      const span = requestSpan(c, 'git.unpushed_hashes', { threadId });
      const r = await getUnpushedHashes(cwd);
      span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
      return r;
    })(),
  ]);
  if (result.isErr()) return resultToResponse(c, result);
  const entries = result.value;
  const hasMore = entries.length > limit;
  const unpushedSet = unpushedResult.isOk() ? unpushedResult.value : new Set<string>();
  const trimmed = hasMore ? entries.slice(0, limit) : entries;
  const unpushedHashes = trimmed.filter((e) => unpushedSet.has(e.hash)).map((e) => e.hash);
  return c.json({ entries: trimmed, hasMore, unpushedHashes });
});

// GET /api/git/:threadId/commit/:hash/files
gitRoutes.get('/:threadId/commit/:hash/files', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const span = requestSpan(c, 'git.commit_files', {
    threadId: c.req.param('threadId'),
    hash: c.req.param('hash'),
  });
  const result = await getCommitFiles(cwdResult.value, c.req.param('hash'));
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ files: result.value });
});

// GET /api/git/:threadId/commit/:hash/diff
gitRoutes.get('/:threadId/commit/:hash/diff', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const filePath = c.req.query('path');
  if (!filePath) {
    return resultToResponse(c, err(badRequest('Missing required query parameter: path')));
  }
  const span = requestSpan(c, 'git.commit_diff', {
    threadId: c.req.param('threadId'),
    hash: c.req.param('hash'),
    path: filePath,
  });
  const result = await getCommitFileDiff(cwdResult.value, c.req.param('hash'), filePath);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ diff: result.value });
});

// GET /api/git/:threadId/commit/:hash/body
gitRoutes.get('/:threadId/commit/:hash/body', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const span = requestSpan(c, 'git.commit_body', {
    threadId: c.req.param('threadId'),
    hash: c.req.param('hash'),
  });
  const result = await getCommitBody(cwdResult.value, c.req.param('hash'));
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ body: result.value });
});

// POST /api/git/:threadId/pull
gitRoutes.post('/:threadId/pull', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(pullSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const result = await gitServicePull(threadId, userId, cwdResult.value, parsed.value.strategy);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/fetch
gitRoutes.post('/:threadId/fetch', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const identity = await resolveIdentity(userId);
  const result = await fetchRemote(cwdResult.value, identity);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/stash
gitRoutes.post('/:threadId/stash', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const body = await c.req.json().catch(() => ({}));
  const files = Array.isArray(body.files) ? body.files : [];
  const result =
    files.length > 0
      ? await gitServiceStashFiles(threadId, userId, cwdResult.value, files)
      : await gitServiceStash(threadId, userId, cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/stash/pop
gitRoutes.post('/:threadId/stash/pop', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const result = await gitServicePopStash(threadId, userId, cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/stash/drop/:stashIndex
gitRoutes.post('/:threadId/stash/drop/:stashIndex', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const stashIndex = parseInt(c.req.param('stashIndex'), 10);
  if (Number.isNaN(stashIndex) || stashIndex < 0) {
    return resultToResponse(c, err(badRequest('Invalid stash index')));
  }
  const result = await gitServiceDropStash(threadId, userId, cwdResult.value, stashIndex);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// GET /api/git/:threadId/stash/list
gitRoutes.get('/:threadId/stash/list', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const span = requestSpan(c, 'git.stash_list', { threadId: c.req.param('threadId') });
  const result = await stashList(cwdResult.value);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ entries: result.value });
});

// GET /api/git/:threadId/stash/show/:stashIndex
gitRoutes.get('/:threadId/stash/show/:stashIndex', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const stashRef = `stash@{${c.req.param('stashIndex')}}`;
  const span = requestSpan(c, 'git.stash_show', {
    threadId: c.req.param('threadId'),
    stashIndex: c.req.param('stashIndex'),
  });
  const result = await stashShow(cwdResult.value, stashRef);
  span.end(result.isOk() ? 'ok' : 'error', result.isErr() ? result.error.message : undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ files: result.value });
});

// POST /api/git/:threadId/reset-soft
gitRoutes.post('/:threadId/reset-soft', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const result = await gitServiceSoftReset(threadId, userId, cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/checkout-commit
gitRoutes.post('/:threadId/checkout-commit', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const { hash } = await c.req.json();
  if (!hash) return c.json({ error: 'hash is required' }, 400);

  const result = await gitServiceCheckoutHash(threadId, userId, cwdResult.value, hash);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/revert-commit
gitRoutes.post('/:threadId/revert-commit', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const { hash } = await c.req.json();
  if (!hash) return c.json({ error: 'hash is required' }, 400);

  const result = await gitServiceRevertCommit(threadId, userId, cwdResult.value, hash);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/reset-hard
gitRoutes.post('/:threadId/reset-hard', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const { hash } = await c.req.json();
  if (!hash) return c.json({ error: 'hash is required' }, 400);

  const result = await gitServiceResetHard(threadId, userId, cwdResult.value, hash);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/gitignore
gitRoutes.post('/:threadId/gitignore', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const patterns: string[] = Array.isArray(raw?.patterns)
    ? raw.patterns.filter((p: unknown) => typeof p === 'string' && p)
    : typeof raw?.pattern === 'string' && raw.pattern
      ? [raw.pattern]
      : [];
  if (patterns.length === 0) {
    return c.json({ error: 'pattern or patterns is required' }, 400);
  }
  for (const p of patterns) {
    const result = addToGitignore(cwd, p);
    if (result.isErr()) return resultToResponse(c, result);
  }
  return c.json({ ok: true });
});
