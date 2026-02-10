import { Hono } from 'hono';
import * as tm from '../services/thread-manager.js';
import { getDiff, stageFiles, unstageFiles, revertFiles, commit, push, createPR, mergeBranch, git } from '../utils/git-v2.js';
import * as wm from '../services/worktree-manager.js';
import { validate, mergeSchema, stageFilesSchema, commitSchema, createPRSchema } from '../validation/schemas.js';
import { sanitizePath } from '../utils/path-validation.js';
import { requireThread, requireThreadCwd, requireProject } from '../utils/route-helpers.js';
import { BadRequest } from '../middleware/error-handler.js';
import { getClaudeBinaryPath } from '../utils/claude-binary.js';
import { execute } from '../utils/process.js';

export const gitRoutes = new Hono();

/**
 * Validate that all file paths stay within the working directory.
 * Prevents directory traversal attacks (e.g. "../../etc/passwd").
 */
function validateFilePaths(cwd: string, paths: string[]): string | null {
  for (const p of paths) {
    try {
      sanitizePath(cwd, p);
    } catch {
      return `Invalid path: ${p}`;
    }
  }
  return null;
}

// GET /api/git/:threadId/diff
gitRoutes.get('/:threadId/diff', async (c) => {
  const cwd = requireThreadCwd(c.req.param('threadId'));
  const diffs = await getDiff(cwd);
  return c.json(diffs);
});

// POST /api/git/:threadId/stage
gitRoutes.post('/:threadId/stage', async (c) => {
  const cwd = requireThreadCwd(c.req.param('threadId'));

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);

  const pathError = validateFilePaths(cwd, parsed.data.paths);
  if (pathError) return c.json({ error: pathError }, 400);

  await stageFiles(cwd, parsed.data.paths);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/unstage
gitRoutes.post('/:threadId/unstage', async (c) => {
  const cwd = requireThreadCwd(c.req.param('threadId'));

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);

  const pathError = validateFilePaths(cwd, parsed.data.paths);
  if (pathError) return c.json({ error: pathError }, 400);

  await unstageFiles(cwd, parsed.data.paths);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/revert
gitRoutes.post('/:threadId/revert', async (c) => {
  const cwd = requireThreadCwd(c.req.param('threadId'));

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(stageFilesSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);

  const pathError = validateFilePaths(cwd, parsed.data.paths);
  if (pathError) return c.json({ error: pathError }, 400);

  await revertFiles(cwd, parsed.data.paths);
  return c.json({ ok: true });
});

// POST /api/git/:threadId/commit
gitRoutes.post('/:threadId/commit', async (c) => {
  const cwd = requireThreadCwd(c.req.param('threadId'));

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(commitSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);

  const result = await commit(cwd, parsed.data.message);
  return c.json({ ok: true, output: result });
});

// POST /api/git/:threadId/push
gitRoutes.post('/:threadId/push', async (c) => {
  const cwd = requireThreadCwd(c.req.param('threadId'));
  const result = await push(cwd);
  return c.json({ ok: true, output: result });
});

// POST /api/git/:threadId/pr
gitRoutes.post('/:threadId/pr', async (c) => {
  const threadId = c.req.param('threadId');
  const cwd = requireThreadCwd(threadId);
  const thread = tm.getThread(threadId);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(createPRSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);

  const url = await createPR(cwd, parsed.data.title, parsed.data.body, thread?.baseBranch ?? undefined);
  return c.json({ ok: true, url });
});

// POST /api/git/:threadId/generate-commit-message
gitRoutes.post('/:threadId/generate-commit-message', async (c) => {
  const cwd = requireThreadCwd(c.req.param('threadId'));
  const diffs = await getDiff(cwd);
  const staged = diffs.filter(d => d.staged);

  if (staged.length === 0) {
    throw BadRequest('No staged files to generate a commit message for');
  }

  const diffSummary = staged
    .map(d => `--- ${d.status}: ${d.path} ---\n${d.diff || '(no diff)'}`)
    .join('\n\n');

  const prompt = `You are a commit message generator. Based on the following staged git diff, write a single concise commit message using conventional commits style (e.g. "feat: ...", "fix: ...", "refactor: ..."). Output ONLY the commit message, nothing else. No quotes, no explanation, no markdown.\n\n${diffSummary}`;

  const binaryPath = getClaudeBinaryPath();
  const { stdout } = await execute(binaryPath, ['--print', '-p', prompt], {
    cwd,
    timeout: 60_000,
  });

  return c.json({ message: stdout.trim() });
});

// POST /api/git/:threadId/merge
gitRoutes.post('/:threadId/merge', async (c) => {
  const threadId = c.req.param('threadId');
  const thread = requireThread(threadId);

  if (thread.mode !== 'worktree' || !thread.branch) {
    throw BadRequest('Merge is only available for worktree threads');
  }

  const project = requireProject(thread.projectId);

  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(mergeSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);

  const targetBranch = parsed.data.targetBranch || thread.baseBranch;
  if (!targetBranch) {
    throw BadRequest('No target branch specified and no baseBranch set on thread');
  }

  let output: string;
  try {
    output = await mergeBranch(project.path, thread.branch, targetBranch);
  } catch (err: any) {
    throw BadRequest(err.message || 'Merge failed');
  }

  if (parsed.data.push) {
    try {
      await git(['push', 'origin', targetBranch], project.path);
    } catch (err: any) {
      throw BadRequest(`Merge succeeded but push failed: ${err.message}`);
    }
  }

  if (parsed.data.cleanup && thread.worktreePath) {
    await wm.removeWorktree(project.path, thread.worktreePath).catch(console.warn);
    await wm.removeBranch(project.path, thread.branch).catch(console.warn);
    tm.updateThread(threadId, { worktreePath: null, branch: null });
  }

  return c.json({ ok: true, output });
});
