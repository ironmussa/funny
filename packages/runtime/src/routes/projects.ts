/**
 * @domain subdomain: Project Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: ProjectHooksService, StartupCommandsService, CommandRunner
 *
 * Runner-only project routes — filesystem, git, and process operations.
 * Project CRUD (list, create, update, delete, reorder, resolve) is handled
 * by the server package directly.
 */

import {
  listBranchesDetailed,
  fetchRemote,
  getDefaultBranch,
  getCurrentBranch,
  git,
  stash,
  invalidateStatusCache,
  getWeaveStatus,
  ensureWeaveConfigured,
} from '@funny/core/git';
import { Hono } from 'hono';

import { log } from '../lib/logger.js';
import { requireAdmin } from '../middleware/auth.js';
import { requestSpan } from '../middleware/tracing.js';
import {
  startCommand,
  stopCommand,
  isCommandRunning,
  getCommandMetrics,
} from '../services/command-runner.js';
import { resolveIdentity } from '../services/git-service.js';
import * as pc from '../services/project-config-service.js';
import * as ph from '../services/project-hooks-service.js';
import { getServices } from '../services/service-registry.js';
import * as tm from '../services/thread-manager.js';
import { wsBroker } from '../services/ws-broker.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { requireProject, requireThread } from '../utils/route-helpers.js';
import {
  createCommandSchema,
  createHookSchema,
  updateHookSchema,
  reorderHooksSchema,
  validate,
} from '../validation/schemas.js';

export const projectRoutes = new Hono<HonoEnv>();

// ─── Git Operations ────────────────────────────────────

// GET /api/projects/:id/branches
projectRoutes.get('/:id/branches', async (c) => {
  const userId = c.get('userId');
  const orgId = c.get('organizationId') ?? undefined;
  const projectResult = await requireProject(c.req.param('id'), userId, orgId);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const project = projectResult.value;
  // Fire-and-forget: fetch remote refs in the background so the response is
  // instant (uses locally cached branch data). The next call will see updated
  // remote branches once the fetch completes.
  const identity = userId ? await resolveIdentity(userId) : undefined;
  void fetchRemote(project.path, identity);
  const [branchesResult, defaultBranchResult, currentBranchResult] = await Promise.all([
    (async () => {
      const span = requestSpan(c, 'git.branches_detailed', { projectId: project.id });
      const r = await listBranchesDetailed(project.path);
      span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
      return r;
    })(),
    (async () => {
      const span = requestSpan(c, 'git.default_branch', { projectId: project.id });
      const r = await getDefaultBranch(project.path);
      span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
      return r;
    })(),
    (async () => {
      const span = requestSpan(c, 'git.current_branch', { projectId: project.id });
      const r = await getCurrentBranch(project.path);
      span.end(r.isOk() ? 'ok' : 'error', r.isErr() ? r.error.message : undefined);
      return r;
    })(),
  ]);

  const detailed = branchesResult.isOk() ? branchesResult.value : [];
  const remoteBranches = detailed.filter((b) => b.isRemote).map((b) => b.name);

  return c.json({
    branches: detailed.map((b) => b.name),
    remoteBranches,
    defaultBranch: defaultBranchResult.isOk() ? defaultBranchResult.value : null,
    currentBranch: currentBranchResult.isOk() ? currentBranchResult.value : null,
  });
});

// GET /api/projects/:id/checkout-preflight?branch=<branch>
projectRoutes.get('/:id/checkout-preflight', async (c) => {
  const projectResult = await requireProject(
    c.req.param('id'),
    c.get('userId'),
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const targetBranch = c.req.query('branch');
  if (!targetBranch) return c.json({ error: 'Missing required query parameter: branch' }, 400);

  const project = projectResult.value;

  const currentBranchResult = await getCurrentBranch(project.path);
  const currentBranch = currentBranchResult.isOk() ? currentBranchResult.value : null;

  if (currentBranch === targetBranch) {
    return c.json({ canCheckout: true, currentBranch, hasDirtyFiles: false });
  }

  const statusResult = await git(['status', '--porcelain'], project.path);
  if (statusResult.isErr()) {
    return c.json({
      canCheckout: false,
      currentBranch,
      reason: 'git_status_failed',
      hasDirtyFiles: false,
    });
  }

  const dirtyFiles = statusResult.value
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => l.slice(3).trim());

  if (dirtyFiles.length === 0) {
    return c.json({ canCheckout: true, currentBranch, hasDirtyFiles: false });
  }

  // There are dirty files — return info so the client can show the Switch Branch dialog
  return c.json({
    canCheckout: false,
    currentBranch,
    reason: 'dirty_files',
    hasDirtyFiles: true,
    dirtyFileCount: dirtyFiles.length,
  });
});

// POST /api/projects/:id/checkout — perform branch checkout with a strategy for dirty files
projectRoutes.post('/:id/checkout', async (c) => {
  const projectResult = await requireProject(
    c.req.param('id'),
    c.get('userId'),
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const body = await c.req.json<{
    branch: string;
    strategy?: 'stash' | 'carry';
    create?: boolean;
    threadId?: string;
  }>();
  const { branch, strategy = 'carry', create = false, threadId } = body;
  if (!branch) return c.json({ error: 'Missing required field: branch' }, 400);

  const project = projectResult.value;

  // Check current branch
  const currentBranchResult = await getCurrentBranch(project.path);
  const currentBranch = currentBranchResult.isOk() ? currentBranchResult.value : null;
  if (currentBranch === branch) {
    return c.json({ ok: true, currentBranch: branch });
  }

  // If strategy is stash, stash changes first
  if (strategy === 'stash') {
    const stashResult = await stash(project.path);
    if (stashResult.isErr()) {
      return c.json({ error: `Failed to stash: ${stashResult.error.message}` }, 500);
    }
  }

  // Checkout the target branch (use -b to create if requested)
  const checkoutArgs = create ? ['checkout', '-b', branch] : ['checkout', branch];
  const checkoutResult = await git(checkoutArgs, project.path);
  if (checkoutResult.isErr()) {
    // If we stashed and checkout failed, try to restore the stash
    if (strategy === 'stash') {
      await git(['stash', 'pop'], project.path);
    }
    return c.json({ error: `Checkout failed: ${checkoutResult.error.message}` }, 500);
  }

  invalidateStatusCache(project.path);

  // If a threadId was provided, update the thread's branch in the DB and notify the client
  if (threadId) {
    await tm.updateThread(threadId, { branch });
    const userId = c.get('userId');
    if (userId) {
      wsBroker.emitToUser(userId, {
        type: 'thread:updated',
        threadId,
        data: { branch },
      });
    }
  }

  return c.json({ ok: true, currentBranch: branch });
});

// ─── Startup Commands ───────────────────────────────────

// GET /api/projects/:id/commands
projectRoutes.get('/:id/commands', async (c) => {
  const id = c.req.param('id');
  const commands = await getServices().startupCommands.listCommands(id);
  return c.json(commands);
});

// POST /api/projects/:id/commands
projectRoutes.post('/:id/commands', async (c) => {
  const projectId = c.req.param('id');
  const raw = await c.req.json();
  const parsed = validate(createCommandSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { label, command } = parsed.value;

  const entry = await getServices().startupCommands.createCommand({ projectId, label, command });
  return c.json(entry, 201);
});

// PUT /api/projects/:id/commands/:cmdId
projectRoutes.put('/:id/commands/:cmdId', async (c) => {
  const cmdId = c.req.param('cmdId');
  const raw = await c.req.json();
  const parsed = validate(createCommandSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { label, command, port, portEnvVar } = parsed.value;

  await getServices().startupCommands.updateCommand(cmdId, { label, command, port, portEnvVar });
  return c.json({ ok: true });
});

// DELETE /api/projects/:id/commands/:cmdId
projectRoutes.delete('/:id/commands/:cmdId', async (c) => {
  const cmdId = c.req.param('cmdId');
  await getServices().startupCommands.deleteCommand(cmdId);
  return c.json({ ok: true });
});

// ─── Command Execution ─────────────────────────────────

// POST /api/projects/:id/commands/:cmdId/start
projectRoutes.post('/:id/commands/:cmdId/start', requireAdmin, async (c) => {
  const projectId = c.req.param('id');
  const cmdId = c.req.param('cmdId');

  const projectResult = await requireProject(
    projectId,
    c.get('userId'),
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const cmd = await getServices().startupCommands.getCommand(cmdId);
  if (!cmd) return c.json({ error: 'Command not found' }, 404);

  // Optional body: auto-restart options + threadId (to run in a worktree cwd)
  let options: import('../services/command-runner.js').RestartOptions | undefined;
  let threadId: string | undefined;
  try {
    const body = await c.req.json();
    if (body?.autoRestart !== undefined) {
      options = {
        autoRestart: body.autoRestart,
        maxRestarts: body.maxRestarts,
        restartWindow: body.restartWindowSec ? body.restartWindowSec * 1000 : undefined,
      };
    }
    if (typeof body?.threadId === 'string' && body.threadId.length > 0) {
      threadId = body.threadId;
    }
  } catch {
    // No body or invalid JSON — that's fine, defaults will be used
  }

  let cwd = project.path;
  if (threadId) {
    const threadResult = await requireThread(
      threadId,
      c.get('userId'),
      c.get('organizationId') ?? undefined,
    );
    if (threadResult.isErr()) return resultToResponse(c, threadResult);
    const thread = threadResult.value;
    if (thread.projectId !== projectId) {
      return c.json({ error: 'Thread does not belong to project' }, 400);
    }
    if (thread.worktreePath) {
      cwd = thread.worktreePath;
      log.info('Starting command in thread worktree', {
        namespace: 'routes:projects',
        commandId: cmdId,
        threadId,
        cwd,
      });
    }
  }

  await startCommand(cmdId, cmd.command, cwd, projectId, cmd.label, options);
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

// GET /api/projects/:id/commands/:cmdId/metrics
projectRoutes.get('/:id/commands/:cmdId/metrics', (c) => {
  const cmdId = c.req.param('cmdId');
  const metrics = getCommandMetrics(cmdId);
  if (!metrics) return c.json({ error: 'Command not running' }, 404);
  return c.json(metrics);
});

// POST /api/projects/:id/sync-processes — sync .funny.json processes + Procfile with startup commands
projectRoutes.post('/:id/sync-processes', requireAdmin, async (c) => {
  const projectId = c.req.param('id');
  const projectResult = await requireProject(
    projectId,
    c.get('userId'),
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const { readProjectConfig } = await import('@funny/core/ports');
  const { readProcfile } = await import('@funny/core/ports');

  const config = readProjectConfig(project.path);
  const configProcesses = config?.processes ?? [];
  const procfileProcesses = readProcfile(project.path);

  // Merge: config processes override Procfile by name
  const merged = new Map<string, { name: string; command: string }>();
  for (const p of procfileProcesses) merged.set(p.name, p);
  for (const p of configProcesses) merged.set(p.name, p);

  const existing = await getServices().startupCommands.listCommands(projectId);
  let synced = 0;

  for (const proc of merged.values()) {
    const match = existing.find((e: any) => e.label === proc.name);
    if (!match) {
      await getServices().startupCommands.createCommand({
        projectId,
        label: proc.name,
        command: proc.command,
      });
      synced++;
    } else if (match.command !== proc.command) {
      await getServices().startupCommands.updateCommand(match.id, {
        label: proc.name,
        command: proc.command,
      });
      synced++;
    }
  }

  return c.json({ synced, total: merged.size });
});

// POST /api/projects/:id/sync-config — sync both processes and automations from .funny.json
projectRoutes.post('/:id/sync-config', requireAdmin, async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const projectResult = await requireProject(
    projectId,
    userId,
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const { syncConfigAutomations } = await import('../services/config-automation-sync.js');
  const automationResult = await syncConfigAutomations(projectId, project.path, userId);

  const { readProjectConfig } = await import('@funny/core/ports');
  const { readProcfile } = await import('@funny/core/ports');
  const config = readProjectConfig(project.path);
  const processCount = (config?.processes?.length ?? 0) + readProcfile(project.path).length;

  return c.json({ automations: automationResult, processes: processCount });
});

// ─── Project Config (.funny.json) ──────────────────────

// GET /api/projects/:id/config
projectRoutes.get('/:id/config', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const config = pc.getConfig(projectResult.value.path);
  return c.json(config);
});

// PUT /api/projects/:id/config
projectRoutes.put('/:id/config', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
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
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
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
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const raw = await c.req.json();
  const parsed = validate(createHookSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const { hookType, label, command } = parsed.value;
  const entry = ph.addCommand(projectResult.value.path, hookType, label, command);
  return c.json(entry, 201);
});

// PUT /api/projects/:id/hooks/reorder
projectRoutes.put('/:id/hooks/reorder', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
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
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
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
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
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
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const result = await getWeaveStatus(projectResult.value.path);
  return resultToResponse(c, result);
});

// POST /api/projects/:id/weave/configure
projectRoutes.post('/:id/weave/configure', async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const orgId = c.get('organizationId');
  const projectResult = await requireProject(projectId, userId, orgId ?? undefined);
  if (projectResult.isErr()) return resultToResponse(c, projectResult);

  const result = await ensureWeaveConfigured(projectResult.value.path);
  if (result.isErr()) return resultToResponse(c, result);
  return c.json({ ok: true, status: result.value });
});
