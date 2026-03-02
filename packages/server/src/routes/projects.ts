/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: ProjectManager, ProjectHooksService, StartupCommandsService, CommandRunner
 */

import { listBranches, getDefaultBranch, getCurrentBranch, executeShell } from '@funny/core/git';
import { Hono } from 'hono';

import { requireAdmin } from '../middleware/auth.js';
import { startCommand, stopCommand, isCommandRunning } from '../services/command-runner.js';
import * as ph from '../services/project-hooks-service.js';
import * as pm from '../services/project-manager.js';
import * as sc from '../services/startup-commands-service.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { requireProject } from '../utils/route-helpers.js';
import {
  createProjectSchema,
  updateProjectSchema,
  reorderProjectsSchema,
  createCommandSchema,
  createHookSchema,
  updateHookSchema,
  runHookSchema,
  validate,
} from '../validation/schemas.js';

export const projectRoutes = new Hono<HonoEnv>();

// GET /api/projects
projectRoutes.get('/', (c) => {
  const userId = c.get('userId') as string;
  const projects = pm.listProjects(userId);
  return c.json(projects);
});

// GET /api/projects/resolve?url=<url>
// Returns the project matching the given URL pattern, or null if none match.
projectRoutes.get('/resolve', (c) => {
  const userId = c.get('userId') as string;
  const url = c.req.query('url');
  if (!url) {
    return c.json({ error: 'Missing required query parameter: url' }, 400);
  }

  const projects = pm.listProjects(userId);
  const matched = projects.find((p) => p.urls?.some((pattern) => url.startsWith(pattern)));

  if (matched) {
    return c.json({ project: matched, source: 'url_match' });
  }
  return c.json({ project: null, source: 'none' });
});

// POST /api/projects
projectRoutes.post('/', async (c) => {
  const userId = c.get('userId') as string;
  const raw = await c.req.json();
  const result = validate(createProjectSchema, raw).andThen(({ name, path }) =>
    pm.createProject(name, path, userId),
  );
  return resultToResponse(c, result, 201);
});

// PATCH /api/projects/:id
projectRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const projectResult = requireProject(id, userId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const raw = await c.req.json();
  const result = validate(updateProjectSchema, raw).andThen((fields) =>
    pm.updateProject(id, fields),
  );
  return resultToResponse(c, result);
});

// DELETE /api/projects/:id
projectRoutes.delete('/:id', (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const projectResult = requireProject(id, userId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  pm.deleteProject(id);
  return c.json({ ok: true });
});

// PUT /api/projects/reorder
projectRoutes.put('/reorder', async (c) => {
  const userId = c.get('userId') as string;
  const raw = await c.req.json();
  const result = validate(reorderProjectsSchema, raw).andThen(({ projectIds }) =>
    pm.reorderProjects(userId, projectIds),
  );
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

  // For empty repos (no commits), branches and currentBranch may fail.
  // Return empty/null defaults instead of an error.
  return c.json({
    branches: branchesResult.isOk() ? branchesResult.value : [],
    defaultBranch: defaultBranchResult.isOk() ? defaultBranchResult.value : null,
    currentBranch: currentBranchResult.isOk() ? currentBranchResult.value : null,
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
// Command execution is restricted to admin users since it runs arbitrary shell commands.

// POST /api/projects/:id/commands/:cmdId/start
projectRoutes.post('/:id/commands/:cmdId/start', requireAdmin, async (c) => {
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

// ─── Project Hooks ──────────────────────────────────────

// GET /api/projects/:id/hooks
projectRoutes.get('/:id/hooks', (c) => {
  const projectId = c.req.param('id');
  const hookType = c.req.query('hookType') as import('@funny/shared').HookType | undefined;
  const hooks = ph.listHooks(projectId, hookType);
  return c.json(hooks);
});

// POST /api/projects/:id/hooks
projectRoutes.post('/:id/hooks', async (c) => {
  const projectId = c.req.param('id');
  const raw = await c.req.json();
  const parsed = validate(createHookSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { hookType, label, command } = parsed.value;
  const entry = ph.createHook({ projectId, hookType, label, command });
  return c.json(entry, 201);
});

// PUT /api/projects/:id/hooks/:hookId
projectRoutes.put('/:id/hooks/:hookId', async (c) => {
  const hookId = c.req.param('hookId');
  const raw = await c.req.json();
  const parsed = validate(updateHookSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  ph.updateHook(hookId, parsed.value);
  return c.json({ ok: true });
});

// DELETE /api/projects/:id/hooks/:hookId
projectRoutes.delete('/:id/hooks/:hookId', (c) => {
  const hookId = c.req.param('hookId');
  ph.deleteHook(hookId);
  return c.json({ ok: true });
});

// POST /api/projects/:id/hooks/:hookId/run
// Executes a single hook command and returns the result.
projectRoutes.post('/:id/hooks/:hookId/run', async (c) => {
  const hookId = c.req.param('hookId');
  const raw = await c.req.json().catch(() => ({}));
  const parsed = validate(runHookSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const hook = ph.getHook(hookId);
  if (!hook) return c.json({ error: 'Hook not found' }, 404);

  try {
    const result = await executeShell(hook.command, {
      cwd: parsed.value.cwd,
      timeout: 120_000,
      reject: false,
    });
    return c.json({
      ok: result.exitCode === 0,
      output: result.stdout + (result.stderr ? '\n' + result.stderr : ''),
      exitCode: result.exitCode,
    });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Hook execution failed';
    return c.json({ ok: false, output: message, exitCode: -1 }, 500);
  }
});
