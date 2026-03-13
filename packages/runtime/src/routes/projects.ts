/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: ProjectManager, ProjectHooksService, StartupCommandsService, CommandRunner
 */

import {
  listBranches,
  getDefaultBranch,
  getCurrentBranch,
  git,
  getWeaveStatus,
  ensureWeaveConfigured,
} from '@funny/core/git';
import { Hono } from 'hono';
import { err } from 'neverthrow';

import { requireAdmin } from '../middleware/auth.js';
import { startCommand, stopCommand, isCommandRunning } from '../services/command-runner.js';
import * as pc from '../services/project-config-service.js';
import * as ph from '../services/project-hooks-service.js';
import * as pm from '../services/project-manager.js';
import * as sc from '../services/startup-commands-service.js';
import { assignProjectToRunner } from '../services/team-client.js';
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
  reorderHooksSchema,
  validate,
} from '../validation/schemas.js';

export const projectRoutes = new Hono<HonoEnv>();

// GET /api/projects
projectRoutes.get('/', async (c) => {
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');

  if (orgId) {
    // Merge user's own projects + team-shared projects, deduped
    const [userProjects, teamProjects] = await Promise.all([
      pm.listProjects(userId),
      pm.listProjectsByOrg(orgId),
    ]);

    const teamProjectIds = new Set(teamProjects.map((p) => p.id));
    const merged = [
      // User's own projects first (annotate those also shared with team)
      ...userProjects.map((p) => ({
        ...p,
        isTeamProject: teamProjectIds.has(p.id),
      })),
      // Team projects not owned by this user
      ...teamProjects
        .filter((p) => p.userId !== userId)
        .map((p) => ({ ...p, isTeamProject: true as const })),
    ];
    return c.json(merged);
  }

  const projects = await pm.listProjects(userId);
  return c.json(projects);
});

// GET /api/projects/resolve?url=<url>
// Returns the project matching the given URL pattern, or null if none match.
projectRoutes.get('/resolve', async (c) => {
  const userId = c.get('userId') as string;
  const url = c.req.query('url');
  if (!url) {
    return c.json({ error: 'Missing required query parameter: url' }, 400);
  }

  const projects = await pm.listProjects(userId);
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
  const parsed = validate(createProjectSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { name, path } = parsed.value;

  // Early duplicate name check before any further validation
  const nameExists = await pm.projectNameExists(name, userId);
  if (nameExists) {
    return resultToResponse(
      c,
      err({ code: 'CONFLICT' as const, message: `A project named "${name}" already exists` }),
    );
  }

  const result = await pm.createProject(name, path, userId);

  // If in team mode, assign the new project to this runner on the central server
  if (result.isOk()) {
    void assignProjectToRunner(result.value);
  }

  return resultToResponse(c, result, 201);
});

// PATCH /api/projects/:id
projectRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(id, userId, orgId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const raw = await c.req.json();
  const parsed = validate(updateProjectSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const result = await pm.updateProject(id, parsed.value);
  return resultToResponse(c, result);
});

// DELETE /api/projects/:id — only the owner can delete
projectRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const userId = c.get('userId') as string;
  // Intentionally NO orgId — only the owner should be able to delete a project
  const projectResult = await requireProject(id, userId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  await pm.deleteProject(id);
  return c.json({ ok: true });
});

// PUT /api/projects/reorder
projectRoutes.put('/reorder', async (c) => {
  const userId = c.get('userId') as string;
  const raw = await c.req.json();
  const parsed = validate(reorderProjectsSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { projectIds } = parsed.value;
  const result = await pm.reorderProjects(userId, projectIds);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true });
});

// GET /api/projects/:id/branches
projectRoutes.get('/:id/branches', async (c) => {
  const projectResult = await requireProject(c.req.param('id'));
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

// GET /api/projects/:id/checkout-preflight?branch=<branch>
// Pre-flight check: can we checkout the target branch without conflicts?
projectRoutes.get('/:id/checkout-preflight', async (c) => {
  const projectResult = await requireProject(c.req.param('id'));
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const targetBranch = c.req.query('branch');
  if (!targetBranch) return c.json({ error: 'Missing required query parameter: branch' }, 400);

  const project = projectResult.value;

  // Get current branch
  const currentBranchResult = await getCurrentBranch(project.path);
  const currentBranch = currentBranchResult.isOk() ? currentBranchResult.value : null;

  // Same branch — no checkout needed
  if (currentBranch === targetBranch) {
    return c.json({ canCheckout: true, currentBranch });
  }

  // Check for dirty files
  const statusResult = await git(['status', '--porcelain'], project.path);
  if (statusResult.isErr()) {
    return c.json({ canCheckout: false, currentBranch, reason: 'git_status_failed' });
  }

  const dirtyFiles = statusResult.value
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.slice(3).trim());

  if (dirtyFiles.length === 0) {
    // No dirty files — checkout is safe
    return c.json({ canCheckout: true, currentBranch });
  }

  // Check which files differ between HEAD and target branch
  const diffResult = await git(['diff', '--name-only', `HEAD...${targetBranch}`], project.path);

  if (diffResult.isErr()) {
    // Can't compare — assume checkout would fail with dirty files
    return c.json({
      canCheckout: false,
      currentBranch,
      reason: 'dirty_files',
      conflictingFiles: dirtyFiles.slice(0, 10),
    });
  }

  const changedInTarget = new Set(diffResult.value.split('\n').filter((l) => l.trim()));

  const conflicting = dirtyFiles.filter((f) => changedInTarget.has(f));

  if (conflicting.length > 0) {
    return c.json({
      canCheckout: false,
      currentBranch,
      reason: 'dirty_files',
      conflictingFiles: conflicting.slice(0, 10),
    });
  }

  // Dirty files exist but none conflict with the target branch
  return c.json({ canCheckout: true, currentBranch });
});

// ─── Startup Commands ───────────────────────────────────

// GET /api/projects/:id/commands
projectRoutes.get('/:id/commands', async (c) => {
  const id = c.req.param('id');
  const commands = await sc.listCommands(id);
  return c.json(commands);
});

// POST /api/projects/:id/commands
projectRoutes.post('/:id/commands', async (c) => {
  const projectId = c.req.param('id');
  const raw = await c.req.json();
  const parsed = validate(createCommandSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { label, command } = parsed.value;

  const entry = await sc.createCommand({ projectId, label, command });
  return c.json(entry, 201);
});

// PUT /api/projects/:id/commands/:cmdId
projectRoutes.put('/:id/commands/:cmdId', async (c) => {
  const cmdId = c.req.param('cmdId');
  const raw = await c.req.json();
  const parsed = validate(createCommandSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { label, command, port, portEnvVar } = parsed.value;

  await sc.updateCommand(cmdId, { label, command, port, portEnvVar });
  return c.json({ ok: true });
});

// DELETE /api/projects/:id/commands/:cmdId
projectRoutes.delete('/:id/commands/:cmdId', async (c) => {
  const cmdId = c.req.param('cmdId');
  await sc.deleteCommand(cmdId);
  return c.json({ ok: true });
});

// ─── Command Execution ─────────────────────────────────
// Command execution is restricted to admin users since it runs arbitrary shell commands.

// POST /api/projects/:id/commands/:cmdId/start
projectRoutes.post('/:id/commands/:cmdId/start', requireAdmin, async (c) => {
  const projectId = c.req.param('id');
  const cmdId = c.req.param('cmdId');

  const projectResult = await requireProject(projectId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const cmd = await sc.getCommand(cmdId);
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

// ─── Project Config (.funny.json) ──────────────────────

// GET /api/projects/:id/config
projectRoutes.get('/:id/config', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const config = pc.getConfig(projectResult.value.path);
  return c.json(config);
});

// PUT /api/projects/:id/config
projectRoutes.put('/:id/config', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const body = await c.req.json();
  pc.updateConfig(projectResult.value.path, body);
  return c.json({ ok: true });
});

// ─── Project Hooks (Husky-backed) ──────────────────────

// GET /api/projects/:id/hooks
projectRoutes.get('/:id/hooks', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const hookType = c.req.query('hookType') as import('@funny/shared').HookType | undefined;
  const hooks = ph.listHooks(projectResult.value.path, hookType);
  return c.json(hooks);
});

// POST /api/projects/:id/hooks — add a command
projectRoutes.post('/:id/hooks', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const raw = await c.req.json();
  const parsed = validate(createHookSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const { hookType, label, command } = parsed.value;
  const entry = ph.addCommand(projectResult.value.path, hookType, label, command);
  return c.json(entry, 201);
});

// PUT /api/projects/:id/hooks/reorder — reorder commands within a hook type
// IMPORTANT: Must be registered before /:hookType/:index to avoid matching "reorder" as hookType
projectRoutes.put('/:id/hooks/reorder', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const raw = await c.req.json();
  const parsed = validate(reorderHooksSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  ph.reorderCommands(projectResult.value.path, parsed.value.hookType, parsed.value.newOrder);
  return c.json({ ok: true });
});

// PUT /api/projects/:id/hooks/:hookType/:index — update a command
projectRoutes.put('/:id/hooks/:hookType/:index', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const hookType = c.req.param('hookType') as import('@funny/shared').HookType;
  const index = parseInt(c.req.param('index'), 10);

  const raw = await c.req.json();
  const parsed = validate(updateHookSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  try {
    ph.updateCommand(projectResult.value.path, hookType, index, parsed.value);
    return c.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Update failed';
    return c.json({ error: message }, 404);
  }
});

// DELETE /api/projects/:id/hooks/:hookType/:index — delete a command
projectRoutes.delete('/:id/hooks/:hookType/:index', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const hookType = c.req.param('hookType') as import('@funny/shared').HookType;
  const index = parseInt(c.req.param('index'), 10);

  try {
    ph.deleteCommand(projectResult.value.path, hookType, index);
    return c.json({ ok: true });
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : 'Delete failed';
    return c.json({ error: message }, 404);
  }
});

// ─── Weave Semantic Merge ────────────────────────────────

// GET /api/projects/:id/weave/status
projectRoutes.get('/:id/weave/status', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const result = await getWeaveStatus(projectResult.value.path);
  return resultToResponse(c, result);
});

// POST /api/projects/:id/weave/configure
projectRoutes.post('/:id/weave/configure', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const result = await ensureWeaveConfigured(projectResult.value.path);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true, status: result.value });
});
