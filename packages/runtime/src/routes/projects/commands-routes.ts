import { Hono } from 'hono';

import { log } from '../../lib/logger.js';
import { requireAdmin } from '../../middleware/auth.js';
import {
  getCommandMetrics,
  isCommandRunning,
  startCommand,
  stopCommand,
} from '../../services/command-runner.js';
import { getServices } from '../../services/service-registry.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { resultToResponse } from '../../utils/result-response.js';
import { requireProject, requireThread } from '../../utils/route-helpers.js';
import { createCommandSchema, validate } from '../../validation/schemas.js';

export const projectCommandsRoutes = new Hono<HonoEnv>();

// GET /api/projects/:id/commands
projectCommandsRoutes.get('/:id/commands', async (c) => {
  const id = c.req.param('id');
  const commands = await getServices().startupCommands.listCommands(id);
  return c.json(commands);
});

// POST /api/projects/:id/commands
projectCommandsRoutes.post('/:id/commands', async (c) => {
  const projectId = c.req.param('id');
  const raw = await c.req.json();
  const parsed = validate(createCommandSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { label, command } = parsed.value;

  const entry = await getServices().startupCommands.createCommand({ projectId, label, command });
  return c.json(entry, 201);
});

// PUT /api/projects/:id/commands/:cmdId
projectCommandsRoutes.put('/:id/commands/:cmdId', async (c) => {
  const cmdId = c.req.param('cmdId');
  const raw = await c.req.json();
  const parsed = validate(createCommandSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);
  const { label, command, port, portEnvVar } = parsed.value;

  await getServices().startupCommands.updateCommand(cmdId, { label, command, port, portEnvVar });
  return c.json({ ok: true });
});

// DELETE /api/projects/:id/commands/:cmdId
projectCommandsRoutes.delete('/:id/commands/:cmdId', async (c) => {
  const cmdId = c.req.param('cmdId');
  await getServices().startupCommands.deleteCommand(cmdId);
  return c.json({ ok: true });
});

// POST /api/projects/:id/commands/:cmdId/start
projectCommandsRoutes.post('/:id/commands/:cmdId/start', requireAdmin, async (c) => {
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

  let options: import('../../services/command-runner.js').RestartOptions | undefined;
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
    // No body or invalid JSON — defaults will be used
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
projectCommandsRoutes.post('/:id/commands/:cmdId/stop', async (c) => {
  const cmdId = c.req.param('cmdId');
  await stopCommand(cmdId);
  return c.json({ ok: true });
});

// GET /api/projects/:id/commands/:cmdId/status
projectCommandsRoutes.get('/:id/commands/:cmdId/status', (c) => {
  const cmdId = c.req.param('cmdId');
  return c.json({ running: isCommandRunning(cmdId) });
});

// GET /api/projects/:id/commands/:cmdId/metrics
projectCommandsRoutes.get('/:id/commands/:cmdId/metrics', (c) => {
  const cmdId = c.req.param('cmdId');
  const metrics = getCommandMetrics(cmdId);
  if (!metrics) return c.json({ error: 'Command not running' }, 404);
  return c.json(metrics);
});

// POST /api/projects/:id/sync-processes — sync .funny.json processes + Procfile with startup commands
projectCommandsRoutes.post('/:id/sync-processes', requireAdmin, async (c) => {
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
projectCommandsRoutes.post('/:id/sync-config', requireAdmin, async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId');
  const projectResult = await requireProject(
    projectId,
    userId,
    c.get('organizationId') ?? undefined,
  );
  if (projectResult.isErr()) return resultToResponse(c, projectResult);
  const project = projectResult.value;

  const { syncConfigAutomations } = await import('../../services/config-automation-sync.js');
  const automationResult = await syncConfigAutomations(projectId, project.path, userId);

  const { readProjectConfig, readProcfile } = await import('@funny/core/ports');
  const config = readProjectConfig(project.path);
  const processCount = (config?.processes?.length ?? 0) + readProcfile(project.path).length;

  return c.json({ automations: automationResult, processes: processCount });
});
