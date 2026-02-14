import { Hono } from 'hono';
import * as pm from '../services/project-manager.js';
import * as sc from '../services/startup-commands-service.js';
import { listBranches, getDefaultBranch, getCurrentBranch } from '../utils/git-v2.js';
import { startCommand, stopCommand, isCommandRunning } from '../services/command-runner.js';
import { createProjectSchema, renameProjectSchema, updateProjectSchema, reorderProjectsSchema, createCommandSchema, validate } from '../validation/schemas.js';
import { requireProject } from '../utils/route-helpers.js';
import { resultToResponse } from '../utils/result-response.js';

export const projectRoutes = new Hono();

// GET /api/projects
projectRoutes.get('/', (c) => {
  const userId = c.get('userId') as string;
  const projects = pm.listProjects(userId);
  return c.json(projects);
});

// POST /api/projects
projectRoutes.post('/', async (c) => {
  const userId = c.get('userId') as string;
  const raw = await c.req.json();
  const result = validate(createProjectSchema, raw)
    .andThen(({ name, path }) => pm.createProject(name, path, userId));
  return resultToResponse(c, result, 201);
});

// PATCH /api/projects/:id
projectRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const raw = await c.req.json();
  const result = validate(updateProjectSchema, raw)
    .andThen((fields) => pm.updateProject(id, fields));
  return resultToResponse(c, result);
});

// DELETE /api/projects/:id
projectRoutes.delete('/:id', (c) => {
  const id = c.req.param('id');
  pm.deleteProject(id);
  return c.json({ ok: true });
});

// PUT /api/projects/reorder
projectRoutes.put('/reorder', async (c) => {
  const userId = c.get('userId') as string;
  const raw = await c.req.json();
  const result = validate(reorderProjectsSchema, raw)
    .andThen(({ projectIds }) => pm.reorderProjects(userId, projectIds));
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true });
});

// GET /api/projects/:id/branches
projectRoutes.get('/:id/branches', async (c) => {
  const projectResult = requireProject(c.req.param('id'));
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const project = projectResult.value;
  const [branchesResult, defaultBranchResult, currentBranchResult] = await Promise.all([
    listBranches(project.path),
    getDefaultBranch(project.path),
    getCurrentBranch(project.path),
  ]);

  if (branchesResult.isErr()) return resultToResponse(c, branchesResult);
  if (defaultBranchResult.isErr()) return resultToResponse(c, defaultBranchResult);
  if (currentBranchResult.isErr()) return resultToResponse(c, currentBranchResult);

  return c.json({
    branches: branchesResult.value,
    defaultBranch: defaultBranchResult.value,
    currentBranch: currentBranchResult.value,
  });
});

// ─── Startup Commands ───────────────────────────────────

// GET /api/projects/:id/commands
projectRoutes.get('/:id/commands', (c) => {
  const id = c.req.param('id');
  const commands = sc.listCommands(id);
  return c.json(commands);
});

// POST /api/projects/:id/commands
projectRoutes.post('/:id/commands', async (c) => {
  const projectId = c.req.param('id');
  const raw = await c.req.json();
  const parsed = validate(createCommandSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { label, command } = parsed.value;

  const entry = sc.createCommand({ projectId, label, command });
  return c.json(entry, 201);
});

// PUT /api/projects/:id/commands/:cmdId
projectRoutes.put('/:id/commands/:cmdId', async (c) => {
  const cmdId = c.req.param('cmdId');
  const raw = await c.req.json();
  const parsed = validate(createCommandSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { label, command, port, portEnvVar } = parsed.value;

  sc.updateCommand(cmdId, { label, command, port, portEnvVar });
  return c.json({ ok: true });
});

// DELETE /api/projects/:id/commands/:cmdId
projectRoutes.delete('/:id/commands/:cmdId', (c) => {
  const cmdId = c.req.param('cmdId');
  sc.deleteCommand(cmdId);
  return c.json({ ok: true });
});

// ─── Command Execution ─────────────────────────────────

// POST /api/projects/:id/commands/:cmdId/start
projectRoutes.post('/:id/commands/:cmdId/start', async (c) => {
  const projectId = c.req.param('id');
  const cmdId = c.req.param('cmdId');

  const projectResult = requireProject(projectId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const cmd = sc.getCommand(cmdId);
  if (!cmd) return c.json({ error: 'Command not found' }, 404);

  await startCommand(cmdId, cmd.command, project.path, projectId, cmd.label);
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
