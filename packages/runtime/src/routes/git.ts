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
  stageFiles,
  unstageFiles,
  revertFiles,
  addToGitignore,
  commit,
  runHookCommand,
  push,
  pull,
  getStatusSummary,
  deriveGitSyncState,
  getLog,
  stash,
  stashPop,
  stashList,
  resetSoft,
  git,
} from '@funny/core/git';
import { badRequest, internal } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err, ok } from 'neverthrow';

import { log } from '../lib/logger.js';
import { requestSpan } from '../middleware/tracing.js';
import {
  stage as gitServiceStage,
  unstage as gitServiceUnstage,
  revert as gitServiceRevert,
  commitChanges as gitServiceCommit,
  pushChanges as gitServicePush,
  pullChanges as gitServicePull,
  stashChanges as gitServiceStash,
  popStash as gitServicePopStash,
  softReset as gitServiceSoftReset,
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
import { resultToResponse } from '../utils/result-response.js';
import { requireThread, requireThreadCwd, requireProject } from '../utils/route-helpers.js';
import {
  validate,
  mergeSchema,
  stageFilesSchema,
  commitSchema,
  createPRSchema,
  workflowSchema,
} from '../validation/schemas.js';

export const gitRoutes = new Hono<HonoEnv>();

/** Compute a stable cache key that groups threads sharing the same git working state. */
export function computeBranchKey(thread: {
  id: string;
  projectId: string;
  branch?: string | null;
  worktreePath?: string | null;
  baseBranch?: string | null;
  mergedAt?: string | null;
}): string {
  // Merged threads (worktree cleaned up, mergedAt set): unique per thread
  if (!thread.branch && !thread.worktreePath && thread.baseBranch && thread.mergedAt)
    return `tid:${thread.id}`;
  // Threads with a branch (worktree or local): group by project + branch
  if (thread.branch) return `${thread.projectId}:${thread.branch}`;
  // Local threads without a branch: group by project
  return thread.projectId;
}

// In-memory cache for bulk git status to avoid spawning excessive git processes.
const _gitStatusCache = new Map<string, { data: any; ts: number }>();
const GIT_STATUS_CACHE_TTL_MS = 5_000; // 5 seconds

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

  const projectResult = await requireProject(projectId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const userId = c.get('userId') as string;
  const threads = await tm.listThreads({ projectId, userId });
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

  const statusSpan = requestSpan(c, 'git.status.aggregate', {
    projectId,
    worktreeCount: worktreeThreads.length,
    localCount: localThreads.length,
    mergedCount: mergedThreads.length,
  });

  const [worktreeResults, localResults] = await Promise.all([
    Promise.allSettled(
      worktreeThreads.map(async (thread) => {
        const summaryResult = await getStatusSummary(
          thread.worktreePath!,
          thread.baseBranch ?? undefined,
          project.path,
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
    Promise.allSettled(
      localThreads.map(async (thread) => {
        const summaryResult = await getStatusSummary(
          project.path,
          thread.baseBranch ?? undefined,
          project.path,
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
  ]);

  statusSpan.end('ok');

  const statuses = [
    ...worktreeResults
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter(Boolean),
    ...(await Promise.all(
      mergedThreads.map(async (t) => {
        const unpushed = t.baseBranch ? await countUnpushedCommits(project.path, t.baseBranch) : 0;
        return {
          threadId: t.id,
          branchKey: computeBranchKey(t),
          state: 'merged' as const,
          dirtyFileCount: 0,
          unpushedCommitCount: unpushed,
          hasRemoteBranch: unpushed > 0,
          isMergedIntoBase: true,
          linesAdded: 0,
          linesDeleted: 0,
        };
      }),
    )),
    ...localResults
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter(Boolean),
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
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  if (!existsSync(cwd)) {
    return resultToResponse(c, err(badRequest(`Working directory does not exist: ${cwd}`)));
  }
  const summaryResult = await getStatusSummary(cwd);
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
  const result = await getDiffSummary(cwd, { excludePatterns, maxFiles });
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
  const result = await getSingleFileDiff(cwd, filePath, staged);
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
  const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 20, 100) : 20;
  const result = await getLog(cwdResult.value, limit);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ entries: result.value });
});

// GET /api/git/project/:projectId/stash/list
gitRoutes.get('/project/:projectId/stash/list', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(c.req.param('projectId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const result = await stashList(cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ entries: result.value });
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
  const result = await runHookCommand(cwd, hooks[hookIndex].command);
  return c.json(result);
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

// POST /api/git/project/:projectId/pull
gitRoutes.post('/project/:projectId/pull', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const identity = await resolveIdentity(userId);
  const result = await pull(cwdResult.value, identity);
  if (result.isErr()) return resultToResponse(c, result);
  _gitStatusCache.delete(projectId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/project/:projectId/stash
gitRoutes.post('/project/:projectId/stash', async (c) => {
  const projectId = c.req.param('projectId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireProjectCwd(projectId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const result = await stash(cwdResult.value);
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
  const pattern = raw?.pattern;
  if (!pattern || typeof pattern !== 'string') {
    return c.json({ error: 'pattern is required' }, 400);
  }
  const result = addToGitignore(cwd, pattern);
  if (result.isErr()) return resultToResponse(c, result);
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

  // Only treat as merged if mergedAt is set (worktree was actually cleaned up
  // after merge). Without this, local-mode threads with branch=null get
  // hardcoded zero stats instead of real git status.
  if (!thread.worktreePath && !thread.branch && thread.baseBranch && thread.mergedAt) {
    const projectResult = await requireProject(thread.projectId);
    const projectPath = projectResult.isOk() ? projectResult.value.path : null;
    const unpushed = projectPath ? await countUnpushedCommits(projectPath, thread.baseBranch) : 0;
    return c.json({
      threadId,
      branchKey: computeBranchKey(thread),
      state: 'merged' as const,
      dirtyFileCount: 0,
      unpushedCommitCount: unpushed,
      hasRemoteBranch: unpushed > 0,
      isMergedIntoBase: true,
      linesAdded: 0,
      linesDeleted: 0,
    });
  }

  const projectResult = await requireProject(thread.projectId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const cwd = thread.worktreePath || project.path;
  const summaryResult = await getStatusSummary(cwd, thread.baseBranch ?? undefined, project.path);
  if (summaryResult.isErr()) return resultToResponse(c, summaryResult);
  const summary = summaryResult.value;

  return c.json({
    threadId,
    branchKey: computeBranchKey(thread),
    state: deriveGitSyncState(summary),
    ...summary,
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
  const result = await getDiffSummary(cwd, { excludePatterns, maxFiles });
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
  const result = await getSingleFileDiff(cwd, filePath, staged);
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
  const diffResult = await getDiff(cwd);
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
  const result = await runHookCommand(cwd, hooks[hookIndex].command);
  return c.json(result);
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
  const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 20, 100) : 20;

  const result = await getLog(cwdResult.value, limit, thread.baseBranch);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ entries: result.value });
});

// POST /api/git/:threadId/pull
gitRoutes.post('/:threadId/pull', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const result = await gitServicePull(threadId, userId, cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  await invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/stash
gitRoutes.post('/:threadId/stash', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(threadId, userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const result = await gitServiceStash(threadId, userId, cwdResult.value);
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

// GET /api/git/:threadId/stash/list
gitRoutes.get('/:threadId/stash/list', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const result = await stashList(cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ entries: result.value });
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

// POST /api/git/:threadId/gitignore
gitRoutes.post('/:threadId/gitignore', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const cwdResult = await requireThreadCwd(c.req.param('threadId'), userId, orgId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const pattern = raw?.pattern;
  if (!pattern || typeof pattern !== 'string') {
    return c.json({ error: 'pattern is required' }, 400);
  }

  const result = addToGitignore(cwd, pattern);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true });
});
