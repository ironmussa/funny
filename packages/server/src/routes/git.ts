import { Hono } from 'hono';
import * as tm from '../services/thread-manager.js';
import { getDiff, stageFiles, unstageFiles, revertFiles, commit, push, createPR, mergeBranch, git, getStatusSummary, deriveGitSyncState } from '../utils/git-v2.js';
import * as wm from '../services/worktree-manager.js';
import { validate, mergeSchema, stageFilesSchema, commitSchema, createPRSchema } from '../validation/schemas.js';
import { sanitizePath } from '../utils/path-validation.js';
import { requireThread, requireThreadCwd, requireProject } from '../utils/route-helpers.js';
import { resultToResponse } from '../utils/result-response.js';
import { badRequest } from '@a-parallel/shared/errors';
import { getClaudeBinaryPath } from '../utils/claude-binary.js';
import { execute } from '../utils/process.js';
import { err } from 'neverthrow';

export const gitRoutes = new Hono();

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

// GET /api/git/status?projectId=xxx — bulk git status for all worktree threads
gitRoutes.get('/status', async (c) => {
  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId required' }, 400);

  const projectResult = requireProject(projectId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const userId = c.get('userId') as string;
  const threads = tm.listThreads({ projectId, userId });
  const worktreeThreads = threads.filter(
    (t) => t.mode === 'worktree' && t.worktreePath && t.branch
  );

  const results = await Promise.allSettled(
    worktreeThreads.map(async (thread) => {
      const summaryResult = await getStatusSummary(
        thread.worktreePath!,
        thread.baseBranch ?? undefined,
        project.path
      );
      if (summaryResult.isErr()) return null;
      const summary = summaryResult.value;
      return {
        threadId: thread.id,
        state: deriveGitSyncState(summary),
        ...summary,
      };
    })
  );

  const statuses = results
    .filter((r): r is PromiseFulfilledResult<any> => r.status === 'fulfilled')
    .map((r) => r.value)
    .filter(Boolean);

  return c.json({ statuses });
});

// GET /api/git/:threadId/status — single thread git status
gitRoutes.get('/:threadId/status', async (c) => {
  const threadId = c.req.param('threadId');
  const threadResult = requireThread(threadId);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  const projectResult = requireProject(thread.projectId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const cwd = thread.worktreePath || project.path;
  const summaryResult = await getStatusSummary(
    cwd,
    thread.baseBranch ?? undefined,
    project.path
  );
  if (summaryResult.isErr()) return resultToResponse(c, summaryResult);
  const summary = summaryResult.value;

  return c.json({
    threadId,
    state: deriveGitSyncState(summary),
    ...summary,
  });
});

// GET /api/git/:threadId/diff
gitRoutes.get('/:threadId/diff', async (c) => {
  const cwdResult = requireThreadCwd(c.req.param('threadId'));
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const diffResult = await getDiff(cwdResult.value);
  if (diffResult.isErr()) return resultToResponse(c, diffResult);
  return c.json(diffResult.value);
});

// POST /api/git/:threadId/stage
gitRoutes.post('/:threadId/stage', async (c) => {
  const cwdResult = requireThreadCwd(c.req.param('threadId'));
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const pathError = validateFilePaths(cwd, parsed.value.paths);
  if (pathError) return c.json({ error: pathError }, 400);

  const result = await stageFiles(cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/unstage
gitRoutes.post('/:threadId/unstage', async (c) => {
  const cwdResult = requireThreadCwd(c.req.param('threadId'));
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const pathError = validateFilePaths(cwd, parsed.value.paths);
  if (pathError) return c.json({ error: pathError }, 400);

  const result = await unstageFiles(cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/revert
gitRoutes.post('/:threadId/revert', async (c) => {
  const cwdResult = requireThreadCwd(c.req.param('threadId'));
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const pathError = validateFilePaths(cwd, parsed.value.paths);
  if (pathError) return c.json({ error: pathError }, 400);

  const result = await revertFiles(cwd, parsed.value.paths);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/commit
gitRoutes.post('/:threadId/commit', async (c) => {
  const cwdResult = requireThreadCwd(c.req.param('threadId'));
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(commitSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const result = await commit(cwd, parsed.value.message);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/push
gitRoutes.post('/:threadId/push', async (c) => {
  const cwdResult = requireThreadCwd(c.req.param('threadId'));
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);

  const result = await push(cwdResult.value);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true, output: result.value });
});

// POST /api/git/:threadId/pr
gitRoutes.post('/:threadId/pr', async (c) => {
  const threadId = c.req.param('threadId');
  const cwdResult = requireThreadCwd(threadId);
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;
  const thread = tm.getThread(threadId);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(createPRSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const result = await createPR(cwd, parsed.value.title, parsed.value.body, thread?.baseBranch ?? undefined);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true, url: result.value });
});

// POST /api/git/:threadId/generate-commit-message
gitRoutes.post('/:threadId/generate-commit-message', async (c) => {
  const cwdResult = requireThreadCwd(c.req.param('threadId'));
  if (cwdResult.isErr()) return resultToResponse(c, cwdResult);
  const cwd = cwdResult.value;

  const diffResult = await getDiff(cwd);
  if (diffResult.isErr()) return resultToResponse(c, diffResult);
  const diffs = diffResult.value;
  const staged = diffs.filter(d => d.staged);

  if (staged.length === 0) {
    return resultToResponse(c, err(badRequest('No staged files to generate a commit message for')));
  }

  const diffSummary = staged
    .map(d => `--- ${d.status}: ${d.path} ---\n${d.diff || '(no diff)'}`)
    .join('\n\n');

  const prompt = `You are a commit message generator. Based on the following staged git diff, write a single concise commit message using conventional commits style (e.g. "feat: ...", "fix: ...", "refactor: ..."). Output ONLY the commit message, nothing else. No quotes, no explanation, no markdown.\n\n${diffSummary}`;

  const binaryPath = getClaudeBinaryPath();
  const { stdout } = await execute(binaryPath, ['--print'], {
    cwd,
    timeout: 60_000,
    stdin: prompt,
  });

  return c.json({ message: stdout.trim() });
});

// POST /api/git/:threadId/merge
gitRoutes.post('/:threadId/merge', async (c) => {
  const threadId = c.req.param('threadId');
  const threadResult = requireThread(threadId);
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
    return resultToResponse(c, err(badRequest('No target branch specified and no baseBranch set on thread')));
  }

  const mergeResult = await mergeBranch(project.path, thread.branch, targetBranch);
  if (mergeResult.isErr()) return resultToResponse(c, mergeResult);

  if (parsed.value.push) {
    const pushResult = await git(['push', 'origin', targetBranch], project.path);
    if (pushResult.isErr()) {
      return resultToResponse(c, err(badRequest(`Merge succeeded but push failed: ${pushResult.error.message}`)));
    }
  }

  if (parsed.value.cleanup && thread.worktreePath) {
    await wm.removeWorktree(project.path, thread.worktreePath).catch(console.warn);
    await wm.removeBranch(project.path, thread.branch).catch(console.warn);
    tm.updateThread(threadId, { worktreePath: null, branch: null });
  }

  return c.json({ ok: true, output: mergeResult.value });
});
