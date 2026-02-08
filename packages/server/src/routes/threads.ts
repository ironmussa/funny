import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { db, schema } from '../db/index.js';
import * as pm from '../services/project-manager.js';
import * as wm from '../services/worktree-manager.js';
import { startAgent, stopAgent, isAgentRunning } from '../services/agent-runner.js';
import type { CreateThreadRequest } from '@a-parallel/shared';

export const threadRoutes = new Hono();

// GET /api/threads?projectId=xxx&includeArchived=true
threadRoutes.get('/', (c) => {
  const projectId = c.req.query('projectId');
  const includeArchived = c.req.query('includeArchived') === 'true';

  if (projectId) {
    const conditions = includeArchived
      ? eq(schema.threads.projectId, projectId)
      : and(eq(schema.threads.projectId, projectId), eq(schema.threads.archived, 0));
    const threads = db
      .select()
      .from(schema.threads)
      .where(conditions)
      .orderBy(desc(schema.threads.createdAt))
      .all();
    return c.json(threads);
  }

  if (includeArchived) {
    const threads = db.select().from(schema.threads).orderBy(desc(schema.threads.createdAt)).all();
    return c.json(threads);
  }

  const threads = db.select().from(schema.threads).where(eq(schema.threads.archived, 0)).orderBy(desc(schema.threads.createdAt)).all();
  return c.json(threads);
});

// GET /api/threads/:id
threadRoutes.get('/:id', (c) => {
  const id = c.req.param('id');
  const thread = db.select().from(schema.threads).where(eq(schema.threads.id, id)).get();

  if (!thread) {
    return c.json({ error: 'Thread not found' }, 404);
  }

  const messages = db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.threadId, id))
    .all();

  const toolCalls = db.select().from(schema.toolCalls).all();

  // Attach tool calls to messages and parse images
  const messagesWithTools = messages.map((msg) => ({
    ...msg,
    images: msg.images ? JSON.parse(msg.images) : undefined,
    toolCalls: toolCalls.filter((tc) => tc.messageId === msg.id),
  }));

  return c.json({ ...thread, messages: messagesWithTools });
});

// POST /api/threads
threadRoutes.post('/', async (c) => {
  console.log('[threads:POST] ====== NEW THREAD REQUEST ======');
  const body = await c.req.json<CreateThreadRequest & { projectId: string; images?: any[] }>();
  const { projectId, title, mode, model, permissionMode, branch, prompt, images } = body;
  console.log(`[threads:POST] projectId=${projectId}, mode=${mode}, model=${model}, permissionMode=${permissionMode}, prompt="${prompt.substring(0, 80)}", images=${images?.length ?? 0}`);

  const project = pm.getProject(projectId);
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  const threadId = nanoid();
  let worktreePath: string | undefined;
  let threadBranch = branch;

  // Create worktree if needed
  if (mode === 'worktree') {
    const branchName = branch ?? `a-parallel/${threadId}`;
    try {
      worktreePath = wm.createWorktree(project.path, branchName);
      threadBranch = branchName;
    } catch (e: any) {
      return c.json({ error: `Failed to create worktree: ${e.message}` }, 500);
    }
  }

  const thread = {
    id: threadId,
    projectId,
    title: title || prompt,
    mode,
    permissionMode: permissionMode || 'autoEdit',
    status: 'pending' as const,
    branch: threadBranch,
    worktreePath,
    cost: 0,
    createdAt: new Date().toISOString(),
  };

  db.insert(schema.threads).values(thread).run();

  // Determine working directory for agent
  const cwd = worktreePath ?? project.path;

  // Start agent asynchronously
  const pMode = permissionMode || 'autoEdit';
  console.log(`[threads:POST] Calling startAgent(${threadId}, cwd=${cwd}, model=${model || 'sonnet'}, permissionMode=${pMode})`);
  startAgent(threadId, prompt, cwd, model || 'sonnet', pMode, images).catch((err) => {
    console.error(`[agent] Error in thread ${threadId}:`, err);
    db.update(schema.threads)
      .set({ status: 'failed', completedAt: new Date().toISOString() })
      .where(eq(schema.threads.id, threadId))
      .run();
  });

  return c.json(thread, 201);
});

// POST /api/threads/:id/message
threadRoutes.post('/:id/message', async (c) => {
  const id = c.req.param('id');
  const { content, model, permissionMode, images } = await c.req.json<{ content: string; model?: string; permissionMode?: string; images?: any[] }>();
  const thread = db.select().from(schema.threads).where(eq(schema.threads.id, id)).get();

  if (!thread) {
    return c.json({ error: 'Thread not found' }, 404);
  }

  const cwd = thread.worktreePath ?? pm.getProject(thread.projectId)?.path;
  if (!cwd) {
    return c.json({ error: 'Project path not found' }, 500);
  }

  const effectiveModel = (model || 'sonnet') as import('@a-parallel/shared').ClaudeModel;
  const effectivePermission = (permissionMode || thread.permissionMode || 'autoEdit') as import('@a-parallel/shared').PermissionMode;

  startAgent(id, content, cwd, effectiveModel, effectivePermission, images).catch(console.error);
  return c.json({ ok: true });
});

// POST /api/threads/:id/stop
threadRoutes.post('/:id/stop', async (c) => {
  const id = c.req.param('id');
  try {
    await stopAgent(id);
    return c.json({ ok: true });
  } catch (e: any) {
    console.error(`[threads] Failed to stop agent ${id}:`, e);
    return c.json({ error: e.message }, 500);
  }
});

// PATCH /api/threads/:id — update thread fields (e.g. archived)
threadRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ archived?: boolean }>();

  const thread = db.select().from(schema.threads).where(eq(schema.threads.id, id)).get();
  if (!thread) {
    return c.json({ error: 'Thread not found' }, 404);
  }

  const updates: Record<string, any> = {};
  if (body.archived !== undefined) {
    updates.archived = body.archived ? 1 : 0;
  }

  if (Object.keys(updates).length > 0) {
    db.update(schema.threads).set(updates).where(eq(schema.threads.id, id)).run();
  }

  const updated = db.select().from(schema.threads).where(eq(schema.threads.id, id)).get();
  return c.json(updated);
});

// DELETE /api/threads/:id
threadRoutes.delete('/:id', (c) => {
  const id = c.req.param('id');
  const thread = db.select().from(schema.threads).where(eq(schema.threads.id, id)).get();

  if (thread) {
    // Stop agent if running
    if (isAgentRunning(id)) {
      stopAgent(id).catch(console.error);
    }

    // Remove worktree if exists
    if (thread.worktreePath) {
      const project = pm.getProject(thread.projectId);
      if (project) {
        try {
          wm.removeWorktree(project.path, thread.worktreePath);
        } catch (e) {
          console.warn(`[cleanup] Failed to remove worktree: ${e}`);
        }
      }
    }

    // Cascade delete handles messages + tool_calls
    db.delete(schema.threads).where(eq(schema.threads.id, id)).run();
  }

  return c.json({ ok: true });
});
