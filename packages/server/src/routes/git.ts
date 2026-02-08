import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db, schema } from '../db/index.js';
import * as pm from '../services/project-manager.js';
import * as diff from '../services/diff-service.js';

export const gitRoutes = new Hono();

// Helper: resolve working directory for a thread
function resolveThreadCwd(threadId: string): string | null {
  const thread = db.select().from(schema.threads).where(eq(schema.threads.id, threadId)).get();
  if (!thread) return null;

  if (thread.worktreePath) return thread.worktreePath;

  const project = pm.getProject(thread.projectId);
  return project?.path ?? null;
}

// GET /api/git/:threadId/diff
gitRoutes.get('/:threadId/diff', async (c) => {
  const cwd = resolveThreadCwd(c.req.param('threadId'));
  if (!cwd) return c.json({ error: 'Thread not found' }, 404);

  try {
    const diffs = await diff.getDiff(cwd);
    return c.json(diffs);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /api/git/:threadId/stage
gitRoutes.post('/:threadId/stage', async (c) => {
  const cwd = resolveThreadCwd(c.req.param('threadId'));
  if (!cwd) return c.json({ error: 'Thread not found' }, 404);

  const { paths } = await c.req.json<{ paths: string[] }>();
  try {
    await diff.stageFiles(cwd, paths);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /api/git/:threadId/unstage
gitRoutes.post('/:threadId/unstage', async (c) => {
  const cwd = resolveThreadCwd(c.req.param('threadId'));
  if (!cwd) return c.json({ error: 'Thread not found' }, 404);

  const { paths } = await c.req.json<{ paths: string[] }>();
  try {
    await diff.unstageFiles(cwd, paths);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /api/git/:threadId/revert
gitRoutes.post('/:threadId/revert', async (c) => {
  const cwd = resolveThreadCwd(c.req.param('threadId'));
  if (!cwd) return c.json({ error: 'Thread not found' }, 404);

  const { paths } = await c.req.json<{ paths: string[] }>();
  try {
    await diff.revertFiles(cwd, paths);
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /api/git/:threadId/commit
gitRoutes.post('/:threadId/commit', async (c) => {
  const cwd = resolveThreadCwd(c.req.param('threadId'));
  if (!cwd) return c.json({ error: 'Thread not found' }, 404);

  const { message } = await c.req.json<{ message: string }>();
  try {
    const result = await diff.commit(cwd, message);
    return c.json({ ok: true, output: result });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /api/git/:threadId/push
gitRoutes.post('/:threadId/push', async (c) => {
  const cwd = resolveThreadCwd(c.req.param('threadId'));
  if (!cwd) return c.json({ error: 'Thread not found' }, 404);

  try {
    const result = await diff.push(cwd);
    return c.json({ ok: true, output: result });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// POST /api/git/:threadId/pr
gitRoutes.post('/:threadId/pr', async (c) => {
  const cwd = resolveThreadCwd(c.req.param('threadId'));
  if (!cwd) return c.json({ error: 'Thread not found' }, 404);

  const { title, body } = await c.req.json<{ title: string; body: string }>();
  try {
    const url = await diff.createPR(cwd, title, body);
    return c.json({ ok: true, url });
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});
