import { existsSync } from 'fs';

import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  getDiff,
  getDiffSummary,
  getSingleFileDiff,
  stageFiles,
  unstageFiles,
  revertFiles,
  addToGitignore,
  commit,
  push,
  pull,
  createPR,
  mergeBranch,
  git,
  getStatusSummary,
  deriveGitSyncState,
  getLog,
  stash,
  stashPop,
  stashList,
  resetSoft,
  type GitIdentityOptions,
  removeWorktree,
  removeBranch,
  sanitizePath,
} from '@funny/core/git';
import { badRequest, internal } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';

import { getAuthMode } from '../lib/auth-mode.js';
import { log } from '../lib/logger.js';
import { getGitIdentity, getGithubToken } from '../services/profile-service.js';
import { threadEventBus } from '../services/thread-event-bus.js';
import { saveThreadEvent } from '../services/thread-event-service.js';
import * as tm from '../services/thread-manager.js';
import { wsBroker } from '../services/ws-broker.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { requireThread, requireThreadCwd, requireProject } from '../utils/route-helpers.js';
import {
  validate,
  mergeSchema,
  stageFilesSchema,
  commitSchema,
  createPRSchema,
} from '../validation/schemas.js';

export const gitRoutes = new Hono<HonoEnv>();

/**
 * Resolve per-user git identity.
 * In local mode, uses the '__local__' profile for GitHub token support.
 * In multi-user mode, uses the authenticated user's profile.
 */
function resolveIdentity(userId: string): GitIdentityOptions | undefined {
  const effectiveUserId =
    getAuthMode() === 'local' || userId === '__local__' ? '__local__' : userId;
  const author = getGitIdentity(effectiveUserId) ?? undefined;
  const githubToken = getGithubToken(effectiveUserId) ?? undefined;
  if (!author && !githubToken) return undefined;
  return { author, githubToken };
}

/**
 * Validate that all file paths stay within the working directory.
 */
function validateFilePaths(cwd: string, paths: string[]): string | null {
  for (const p of paths) {
    const result = sanitizePath(cwd, p);
    if (result.isErr()) return `Invalid path: ${p}`;
  }
  return null;
}

// In-memory cache for bulk git status to avoid spawning excessive git processes.
const _gitStatusCache = new Map<string, { data: any; ts: number }>();
const GIT_STATUS_CACHE_TTL_MS = 5_000; // 5 seconds

/** Invalidate cached git status for a project after mutating git operations. */
function invalidateGitStatusCache(threadId: string) {
  const thread = tm.getThread(threadId);
  if (thread) _gitStatusCache.delete(thread.projectId);
}

/** Invalidate cached git status by project ID directly. Exported for use by event handlers. */
export function invalidateGitStatusCacheByProject(projectId: string) {
  _gitStatusCache.delete(projectId);
}

// GET /api/git/status?projectId=xxx — bulk git status for all worktree threads
gitRoutes.get('/status', async (c) => {
  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId required' }, 400);

  // Return cached result if still fresh
  const cached = _gitStatusCache.get(projectId);
  if (cached && Date.now() - cached.ts < GIT_STATUS_CACHE_TTL_MS) {
    return c.json(cached.data);
  }

  const projectResult = requireProject(projectId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const userId = c.get('userId') as string;
  const threads = tm.listThreads({ projectId, userId });
  const worktreeThreads = threads.filter(
    (t) => t.mode === 'worktree' && t.worktreePath && t.branch,
  );
  // Threads whose worktrees were cleaned up after merge
  const mergedThreads = threads.filter((t) => !t.worktreePath && !t.branch && t.baseBranch);

  const results = await Promise.allSettled(
    worktreeThreads.map(async (thread) => {
      const summaryResult = await getStatusSummary(
        thread.worktreePath!,
        thread.baseBranch ?? undefined,
        project.path,
      );
      if (summaryResult.isErr()) return null;
      const summary = summaryResult.value;
      return Object.assign({ threadId: thread.id, state: deriveGitSyncState(summary) }, summary);
    }),
  );

  const statuses = [
    ...results
      .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter(Boolean),
    ...mergedThreads.map((t) => ({
      threadId: t.id,
      state: 'merged' as const,
      dirtyFileCount: 0,
      unpushedCommitCount: 0,
      hasRemoteBranch: false,
      isMergedIntoBase: true,
      linesAdded: 0,
      linesDeleted: 0,
    })),
  ];

  const response = { statuses };
  _gitStatusCache.set(projectId, { data: response, ts: Date.now() });
  return c.json(response);
});

// GET /api/git/:threadId/status — single thread git status
gitRoutes.get('/:threadId/status', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const threadResult = requireThread(threadId, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  // Thread was a worktree that got merged & cleaned up — return "merged" directly
  if (!thread.worktreePath && !thread.branch && thread.baseBranch) {
    return c.json({
      threadId,
      state: 'merged' as const,
      dirtyFileCount: 0,
      unpushedCommitCount: 0,
      hasRemoteBranch: false,
      isMergedIntoBase: true,
      linesAdded: 0,
      linesDeleted: 0,
    });
  }

  const projectResult = requireProject(thread.projectId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const cwd = thread.worktreePath || project.path;
  const summaryResult = await getStatusSummary(cwd, thread.baseBranch ?? undefined, project.path);
  if (summaryResult.isErr()) return resultToResponse(c, summaryResult);
  const summary = summaryResult.value;

  return c.json({
    threadId,
    state: deriveGitSyncState(summary),
    ...summary,
  });
});

// GET /api/git/:threadId/diff/summary — lightweight file list without diff content
gitRoutes.get('/:threadId/diff/summary', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = requireThreadCwd(c.req.param('threadId'), userId);
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

// GET /api/git/:threadId/diff/file — diff content for a single file
gitRoutes.get('/:threadId/diff/file', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = requireThreadCwd(c.req.param('threadId'), userId);
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

// GET /api/git/:threadId/diff — full diff (legacy, kept for backward compatibility)
gitRoutes.get('/:threadId/diff', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = requireThreadCwd(c.req.param('threadId'), userId);
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
  const userId = c.get('userId') as string;
  const cwdResult = requireThreadCwd(c.req.param('threadId'), userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const pathError = validateFilePaths(cwd, parsed.value.paths);
  if (pathError) return c.json({ error: pathError }, 400);

  const result = await stageFiles(cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);
  invalidateGitStatusCache(c.req.param('threadId'));
  return c.json({ ok: true });
});

// POST /api/git/:threadId/unstage
gitRoutes.post('/:threadId/unstage', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = requireThreadCwd(c.req.param('threadId'), userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const pathError = validateFilePaths(cwd, parsed.value.paths);
  if (pathError) return c.json({ error: pathError }, 400);

  const result = await unstageFiles(cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);
  invalidateGitStatusCache(c.req.param('threadId'));
  return c.json({ ok: true });
});

// POST /api/git/:threadId/revert
gitRoutes.post('/:threadId/revert', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = requireThreadCwd(c.req.param('threadId'), userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const pathError = validateFilePaths(cwd, parsed.value.paths);
  if (pathError) return c.json({ error: pathError }, 400);

  const result = await revertFiles(cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);
  invalidateGitStatusCache(c.req.param('threadId'));
  return c.json({ ok: true });
});

// POST /api/git/:threadId/commit
gitRoutes.post('/:threadId/commit', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const cwdResult = requireThreadCwd(threadId, userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(commitSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const identity = resolveIdentity(userId);
  const result = await commit(cwd, parsed.value.message, identity, parsed.value.amend);
  if (result.isErr()) return resultToResponse(c, result);

  const thread = requireThread(threadId, userId);
  threadEventBus.emit('git:committed', {
    threadId,
    userId,
    projectId: thread.isOk() ? thread.value.projectId : '',
    message: parsed.value.message,
    amend: parsed.value.amend,
    cwd,
  });

  invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/push
gitRoutes.post('/:threadId/push', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const cwdResult = requireThreadCwd(threadId, userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const identity = resolveIdentity(userId);
  const result = await push(cwdResult.value, identity);
  if (result.isErr()) return resultToResponse(c, result);

  const thread = requireThread(threadId, userId);
  threadEventBus.emit('git:pushed', {
    threadId,
    userId,
    projectId: thread.isOk() ? thread.value.projectId : '',
    cwd: cwdResult.value,
  });

  invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/pr
gitRoutes.post('/:threadId/pr', async (c) => {
  const threadId = c.req.param('threadId');
  const userId = c.get('userId') as string;
  const cwdResult = requireThreadCwd(threadId, userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const thread = tm.getThread(threadId);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(createPRSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const identity = resolveIdentity(userId);
  const result = await createPR(
    cwd,
    parsed.value.title,
    parsed.value.body,
    thread?.baseBranch ?? undefined,
    identity,
  );
  if (result.isErr()) return resultToResponse(c, result);

  const prUrl = result.value;
  const prData = { title: parsed.value.title, url: prUrl };
  await saveThreadEvent(threadId, 'git:pr_created', prData);
  wsBroker.emitToUser(userId, {
    type: 'thread:event',
    threadId,
    data: {
      event: {
        id: crypto.randomUUID(),
        threadId,
        type: 'git:pr_created',
        data: JSON.stringify(prData),
        createdAt: new Date().toISOString(),
      },
    },
  });

  return c.json({ ok: true, url: prUrl });
});

// POST /api/git/:threadId/generate-commit-message
gitRoutes.post('/:threadId/generate-commit-message', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = requireThreadCwd(c.req.param('threadId'), userId);
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

  // Truncate diff to stay within command-line length limits (~32k on Windows).
  // Reserve space for the prompt template and CLI args.
  const MAX_DIFF_LEN = 20_000;
  if (diffSummary.length > MAX_DIFF_LEN) {
    diffSummary = diffSummary.slice(0, MAX_DIFF_LEN) + '\n\n... (diff truncated for length)';
  }

  const prompt = `You are a commit message generator. Based on the following git diff, generate a commit title and a commit body.

Rules:
- The title must use conventional commits style (e.g. "feat: ...", "fix: ...", "refactor: ..."), be concise (max 72 chars), and summarize the change.
- The body must be a short paragraph (2-4 sentences) explaining what changed and why.
- Output EXACTLY in this format, with the separator line:
TITLE: <the title>
BODY: <the body>

No quotes, no markdown, no extra explanation.

${diffSummary}`;

  // Use SDK query() for one-shot commit message generation
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
          systemPrompt: { type: 'preset', preset: 'claude_code' },
          tools: { type: 'preset', preset: 'claude_code' },
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

  // Detect CLI/SDK error messages returned as text instead of exceptions
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
  const threadResult = requireThread(threadId, userId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  if (thread.mode !== 'worktree' || !thread.branch) {
    return resultToResponse(c, err(badRequest('Merge is only available for worktree threads')));
  }

  const projectResult = requireProject(thread.projectId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(mergeSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const targetBranch = parsed.value.targetBranch || thread.baseBranch;
  if (!targetBranch) {
    return resultToResponse(
      c,
      err(badRequest('No target branch specified and no baseBranch set on thread')),
    );
  }

  const identity = resolveIdentity(userId);
  const mergeResult = await mergeBranch(
    project.path,
    thread.branch,
    targetBranch,
    identity,
    thread.worktreePath ?? undefined,
  );
  if (mergeResult.isErr()) return resultToResponse(c, mergeResult);

  threadEventBus.emit('git:merged', {
    threadId,
    userId,
    projectId: thread.projectId,
    sourceBranch: thread.branch,
    targetBranch,
    output: mergeResult.value,
  });

  if (parsed.value.push) {
    const env = identity?.githubToken ? { GH_TOKEN: identity.githubToken } : undefined;
    const pushResult = await git(['push', 'origin', targetBranch], project.path, env);
    if (pushResult.isErr()) {
      return resultToResponse(
        c,
        err(badRequest(`Merge succeeded but push failed: ${pushResult.error.message}`)),
      );
    }
  }

  if (parsed.value.cleanup && thread.worktreePath) {
    await removeWorktree(project.path, thread.worktreePath).catch((e) =>
      log.warn('Failed to remove worktree after merge', { namespace: 'git', error: String(e) }),
    );
    await removeBranch(project.path, thread.branch).catch((e) =>
      log.warn('Failed to remove branch after merge', { namespace: 'git', error: String(e) }),
    );
    tm.updateThread(threadId, { worktreePath: null, branch: null, mode: 'local' });
    // Do NOT call cleanupThreadState — the thread remains active for follow-ups.
    // In-memory deduplication maps (processedToolUseIds, cliToDbMsgId) must be
    // preserved so session resume can deduplicate re-sent content.

    // Broadcast merged status so Kanban cards update immediately
    wsBroker.emitToUser(userId, {
      type: 'git:status',
      threadId,
      data: {
        statuses: [
          {
            threadId,
            state: 'merged' as const,
            dirtyFileCount: 0,
            unpushedCommitCount: 0,
            hasRemoteBranch: false,
            isMergedIntoBase: true,
            linesAdded: 0,
            linesDeleted: 0,
          },
        ],
      },
    });
  }

  invalidateGitStatusCache(threadId);
  return c.json({ ok: true, output: mergeResult.value });
});

// GET /api/git/:threadId/log — recent commit log
gitRoutes.get('/:threadId/log', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = requireThreadCwd(c.req.param('threadId'), userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const limitRaw = c.req.query('limit');
  const limit = limitRaw ? Math.min(parseInt(limitRaw, 10) || 20, 100) : 20;

  const result = await getLog(cwdResult.value, limit);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ entries: result.value });
});

// POST /api/git/:threadId/pull — pull from remote (ff-only)
gitRoutes.post('/:threadId/pull', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = requireThreadCwd(c.req.param('threadId'), userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const identity = resolveIdentity(userId);
  const result = await pull(cwdResult.value, identity);
  if (result.isErr()) return resultToResponse(c, result);
  invalidateGitStatusCache(c.req.param('threadId'));
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/stash — stash current changes
gitRoutes.post('/:threadId/stash', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = requireThreadCwd(c.req.param('threadId'), userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const result = await stash(cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  invalidateGitStatusCache(c.req.param('threadId'));
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/stash/pop — pop most recent stash
gitRoutes.post('/:threadId/stash/pop', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = requireThreadCwd(c.req.param('threadId'), userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const result = await stashPop(cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  invalidateGitStatusCache(c.req.param('threadId'));
  return c.json({ ok: true, output: result.value });
});

// GET /api/git/:threadId/stash/list — list stash entries
gitRoutes.get('/:threadId/stash/list', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = requireThreadCwd(c.req.param('threadId'), userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const result = await stashList(cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ entries: result.value });
});

// POST /api/git/:threadId/reset-soft — undo last commit keeping changes
gitRoutes.post('/:threadId/reset-soft', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = requireThreadCwd(c.req.param('threadId'), userId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const result = await resetSoft(cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  invalidateGitStatusCache(c.req.param('threadId'));
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/gitignore
gitRoutes.post('/:threadId/gitignore', async (c) => {
  const userId = c.get('userId') as string;
  const cwdResult = requireThreadCwd(c.req.param('threadId'), userId);
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
