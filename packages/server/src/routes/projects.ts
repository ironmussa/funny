import { Hono } from 'hono';
import { eq, asc } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import * as pm from '../services/project-manager.js';
import { listBranches } from '../utils/git-v2.js';
import { db, schema } from '../db/index.js';
import { startCommand, stopCommand, isCommandRunning } from '../services/command-runner.js';

export const projectRoutes = new Hono();

// GET /api/projects
projectRoutes.get('/', (c) => {
  const projects = pm.listProjects();
  return c.json(projects);
});

// POST /api/projects
projectRoutes.post('/', async (c) => {
  const { name, path } = await c.req.json<{ name: string; path: string }>();

  if (!name || !path) {
    return c.json({ error: 'name and path are required' }, 400);
  }

  try {
    const project = pm.createProject(name, path);
    return c.json(project, 201);
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// DELETE /api/projects/:id
projectRoutes.delete('/:id', (c) => {
  const id = c.req.param('id');
  pm.deleteProject(id);
  return c.json({ ok: true });
});

// GET /api/projects/:id/branches
projectRoutes.get('/:id/branches', async (c) => {
  const id = c.req.param('id');
  const project = pm.getProject(id);

  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  try {
    const branches = await listBranches(project.path);
    return c.json(branches);
  } catch (e: any) {
    return c.json({ error: e.message }, 500);
  }
});

// ─── Startup Commands ───────────────────────────────────

// GET /api/projects/:id/commands
projectRoutes.get('/:id/commands', (c) => {
  const id = c.req.param('id');
  const commands = db
    .select()
    .from(schema.startupCommands)
    .where(eq(schema.startupCommands.projectId, id))
    .orderBy(asc(schema.startupCommands.sortOrder))
    .all();
  return c.json(commands);
});

// POST /api/projects/:id/commands
projectRoutes.post('/:id/commands', async (c) => {
  const projectId = c.req.param('id');
  const { label, command } = await c.req.json<{ label: string; command: string }>();

  if (!label || !command) {
    return c.json({ error: 'label and command are required' }, 400);
  }

  const existing = db
    .select()
    .from(schema.startupCommands)
    .where(eq(schema.startupCommands.projectId, projectId))
    .all();

  const entry = {
    id: nanoid(),
    projectId,
    label,
    command,
    sortOrder: existing.length,
    createdAt: new Date().toISOString(),
  };

  db.insert(schema.startupCommands).values(entry).run();
  return c.json(entry, 201);
});

// PUT /api/projects/:id/commands/:cmdId
projectRoutes.put('/:id/commands/:cmdId', async (c) => {
  const cmdId = c.req.param('cmdId');
  const { label, command } = await c.req.json<{ label: string; command: string }>();

  if (!label || !command) {
    return c.json({ error: 'label and command are required' }, 400);
  }

  db.update(schema.startupCommands)
    .set({ label, command })
    .where(eq(schema.startupCommands.id, cmdId))
    .run();

  return c.json({ ok: true });
});

// DELETE /api/projects/:id/commands/:cmdId
projectRoutes.delete('/:id/commands/:cmdId', (c) => {
  const cmdId = c.req.param('cmdId');
  db.delete(schema.startupCommands)
    .where(eq(schema.startupCommands.id, cmdId))
    .run();
  return c.json({ ok: true });
});

// ─── Command Execution ─────────────────────────────────

// POST /api/projects/:id/commands/:cmdId/start
projectRoutes.post('/:id/commands/:cmdId/start', (c) => {
  const projectId = c.req.param('id');
  const cmdId = c.req.param('cmdId');

  const project = pm.getProject(projectId);
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  const cmd = db
    .select()
    .from(schema.startupCommands)
    .where(eq(schema.startupCommands.id, cmdId))
    .get();

  if (!cmd) {
    return c.json({ error: 'Command not found' }, 404);
  }

  startCommand(cmdId, cmd.command, project.path, projectId, cmd.label);
  return c.json({ ok: true });
});

// POST /api/projects/:id/commands/:cmdId/stop
projectRoutes.post('/:id/commands/:cmdId/stop', async (c) => {
  const cmdId = c.req.param('cmdId');
  await stopCommand(cmdId);
  return c.json({ ok: true });
});

// GET /api/projects/:id/commands/:cmdId/status
projectRoutes.get('/:id/commands/:cmdId/status', (c) => {
  const cmdId = c.req.param('cmdId');
  return c.json({ running: isCommandRunning(cmdId) });
});
