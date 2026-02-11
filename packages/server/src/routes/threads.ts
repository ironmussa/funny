import { Hono } from 'hono';
import * as tm from '../services/thread-manager.js';
import * as pm from '../services/project-manager.js';
import * as wm from '../services/worktree-manager.js';
import { startAgent, stopAgent, isAgentRunning } from '../services/agent-runner.js';
import { nanoid } from 'nanoid';
import { createThreadSchema, sendMessageSchema, updateThreadSchema, validate } from '../validation/schemas.js';
import { requireThread, requireThreadWithMessages, requireProject } from '../utils/route-helpers.js';
import { resultToResponse } from '../utils/result-response.js';
import { notFound } from '@a-parallel/shared/errors';

export const threadRoutes = new Hono();

/** Create a URL-safe slug from a title for branch naming */
function slugifyTitle(title: string, maxLength = 40): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, maxLength)
    .replace(/-$/, '') || 'thread';
}

// GET /api/threads?projectId=xxx&includeArchived=true
threadRoutes.get('/', (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.query('projectId');
  const includeArchived = c.req.query('includeArchived') === 'true';
  const threads = tm.listThreads({ projectId: projectId || undefined, userId, includeArchived });
  return c.json(threads);
});

// GET /api/threads/archived?page=1&limit=100&search=xxx
threadRoutes.get('/archived', (c) => {
  const userId = c.get('userId') as string;
  const page = Math.max(1, parseInt(c.req.query('page') || '1', 10));
  const limit = Math.min(1000, Math.max(1, parseInt(c.req.query('limit') || '100', 10)));
  const search = c.req.query('search')?.trim() || '';

  const { threads, total } = tm.listArchivedThreads({ page, limit, search, userId });
  return c.json({ threads, total, page, limit });
});

// GET /api/threads/:id
threadRoutes.get('/:id', (c) => {
  const result = requireThreadWithMessages(c.req.param('id'));
  if (result.isErr()) return resultToResponse(c, result);
  return c.json(result.value);
});

// POST /api/threads
threadRoutes.post('/', async (c) => {
  const raw = await c.req.json();
  const parsed = validate(createThreadSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { projectId, title, mode, model, permissionMode, baseBranch, prompt, images } = parsed.value;

  const projectResult = requireProject(projectId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const threadId = nanoid();
  let worktreePath: string | undefined;
  let threadBranch: string | undefined;

  // Create worktree if needed
  const resolvedBaseBranch = baseBranch?.trim() || undefined;
  if (mode === 'worktree') {
    const slug = slugifyTitle(title || prompt);
    const projectSlug = slugifyTitle(project.name);
    const branchName = `${projectSlug}/${slug}-${threadId.slice(0, 6)}`;
    const wtResult = await wm.createWorktree(project.path, branchName, resolvedBaseBranch);
    if (wtResult.isErr()) {
      return c.json({ error: `Failed to create worktree: ${wtResult.error.message}` }, 500);
    }
    worktreePath = wtResult.value;
    threadBranch = branchName;
  }

  const userId = c.get('userId') as string;
  const thread = {
    id: threadId,
    projectId,
    userId,
    title: title || prompt,
    mode,
    permissionMode: permissionMode || 'autoEdit',
    status: 'pending' as const,
    branch: threadBranch,
    baseBranch: mode === 'worktree' ? resolvedBaseBranch : undefined,
    worktreePath,
    cost: 0,
    createdAt: new Date().toISOString(),
  };

  tm.createThread(thread);

  const cwd = worktreePath ?? project.path;

  const pMode = permissionMode || 'autoEdit';
  startAgent(threadId, prompt, cwd, model || 'sonnet', pMode, images).catch((err) => {
    console.error(`[agent] Error in thread ${threadId}:`, err);
    tm.updateThread(threadId, { status: 'failed', completedAt: new Date().toISOString() });
  });

  return c.json(thread, 201);
});

// POST /api/threads/:id/message
threadRoutes.post('/:id/message', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json();
  const parsed = validate(sendMessageSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { content, model, permissionMode, images } = parsed.value;

  const threadResult = requireThread(id);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  const cwd = thread.worktreePath ?? pm.getProject(thread.projectId)?.path;
  if (!cwd) return c.json({ error: 'Project path not found' }, 404);

  const effectiveModel = (model || 'sonnet') as import('@a-parallel/shared').ClaudeModel;
  const effectivePermission = (permissionMode || thread.permissionMode || 'autoEdit') as import('@a-parallel/shared').PermissionMode;

  startAgent(id, content, cwd, effectiveModel, effectivePermission, images).catch(console.error);
  return c.json({ ok: true });
});

// POST /api/threads/:id/stop
threadRoutes.post('/:id/stop', async (c) => {
  await stopAgent(c.req.param('id'));
  return c.json({ ok: true });
});

// PATCH /api/threads/:id — update thread fields (e.g. archived)
threadRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json();
  const parsed = validate(updateThreadSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const threadResult = requireThread(id);
  if (threadResult.isErr()) return resultToResponse(c, threadResult);
  const thread = threadResult.value;

  const updates: Record<string, any> = {};
  if (parsed.value.archived !== undefined) {
    updates.archived = parsed.value.archived ? 1 : 0;
  }

  // Cleanup worktree + branch when archiving
  if (parsed.value.archived && thread.worktreePath) {
    const project = pm.getProject(thread.projectId);
    if (project) {
      await wm.removeWorktree(project.path, thread.worktreePath).catch((e) => {
        console.warn(`[cleanup] Failed to remove worktree: ${e}`);
      });
      if (thread.branch) {
        await wm.removeBranch(project.path, thread.branch).catch((e) => {
          console.warn(`[cleanup] Failed to remove branch: ${e}`);
        });
      }
    }
    updates.worktreePath = null;
    updates.branch = null;
  }

  if (Object.keys(updates).length > 0) {
    tm.updateThread(id, updates);
  }

  const updated = tm.getThread(id);
  return c.json(updated);
});

// DELETE /api/threads/:id
threadRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const thread = tm.getThread(id);

  if (thread) {
    if (isAgentRunning(id)) {
      stopAgent(id).catch(console.error);
    }

    if (thread.worktreePath) {
      const project = pm.getProject(thread.projectId);
      if (project) {
        await wm.removeWorktree(project.path, thread.worktreePath).catch((e) => {
          console.warn(`[cleanup] Failed to remove worktree: ${e}`);
        });
        if (thread.branch) {
          await wm.removeBranch(project.path, thread.branch).catch((e) => {
            console.warn(`[cleanup] Failed to remove branch: ${e}`);
          });
        }
      }
    }

    tm.deleteThread(id);
  }

  return c.json({ ok: true });
});
