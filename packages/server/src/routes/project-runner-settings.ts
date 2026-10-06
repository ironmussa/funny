/**
 * Project runner binding settings (project-runner-binding).
 *
 *   GET    /api/projects/:id/runner-settings            — current binding + candidate runners
 *   PUT    /api/projects/:id/runner-settings            — set/clear dedicated runner, git token
 *   POST   /api/projects/:id/runner-grants/:runnerId    — grant an extra runner access
 *   DELETE /api/projects/:id/runner-grants/:runnerId    — revoke it
 *   PUT    /api/projects/general-runner                 — designate the user's general runner
 *
 * Only the project OWNER may change which runner serves the project. Any runner
 * that loses access has its running agents for the project stopped; its files
 * stay on disk.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';

import { db } from '../db/index.js';
import { threads } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import * as projectRepo from '../services/project-repository.js';
import { buildForwardHeaders } from '../services/runner-forwarding.js';
import { listRunnersByUser } from '../services/runner-manager.js';
import type { RunnerRequestPort } from '../services/runner-ports.js';
import {
  getGeneralRunnerId,
  getProjectRunnerSettings,
  grantProjectRunner,
  revokeProjectRunner,
  setGeneralRunner,
  setProjectDedicatedRunner,
  setProjectGithubToken,
} from '../services/runner-scope.js';
import { parseJsonBody } from '../validation/request.js';

export const projectRunnerSettingsRoutes = new Hono<ServerEnv>();

const ACTIVE_STATUSES = ['running', 'waiting', 'pending'];

/** Stop the project's active agents on runners that just lost access. */
export async function stopProjectSessionsOnRunners(
  requests: RunnerRequestPort | undefined,
  ownerId: string,
  projectId: string,
  runnerIds: string[],
): Promise<void> {
  if (!requests || runnerIds.length === 0) return;
  const active = await db
    .select({ id: threads.id, runnerId: threads.runnerId })
    .from(threads)
    .where(
      and(
        eq(threads.projectId, projectId),
        inArray(threads.runnerId, runnerIds),
        inArray(threads.status, ACTIVE_STATUSES),
      ),
    );
  for (const t of active) {
    if (!t.runnerId || !requests.isAvailable(t.runnerId)) continue;
    try {
      await requests.request(t.runnerId, {
        method: 'POST',
        path: `/api/threads/${t.id}/stop`,
        headers: buildForwardHeaders(ownerId),
        body: null,
      });
    } catch (e) {
      log.warn('Failed to stop thread on revoked runner', {
        namespace: 'project-runner-settings',
        projectId,
        runnerId: t.runnerId,
        threadId: t.id,
        error: (e as Error).message,
      });
    }
  }
}

async function requireOwnedProject(projectId: string, userId: string) {
  const project = await projectRepo.getProject(projectId);
  return project && project.userId === userId ? project : null;
}

projectRunnerSettingsRoutes.put('/general-runner', async (c) => {
  const userId = c.get('userId') as string;
  const parsed = await parseJsonBody(c, z.object({ runnerId: z.string().min(1).nullable() }));
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const ok = await setGeneralRunner(userId, parsed.value.runnerId);
  if (!ok) return c.json({ error: 'Runner not found' }, 404);
  return c.json({ generalRunnerId: parsed.value.runnerId });
});

projectRunnerSettingsRoutes.get('/:id/runner-settings', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.param('id');
  if (!(await requireOwnedProject(projectId, userId))) {
    return c.json({ error: 'Project not found' }, 404);
  }
  const settings = await getProjectRunnerSettings(projectId);
  return c.json({
    ...settings,
    generalRunnerId: await getGeneralRunnerId(userId),
    runners: await listRunnersByUser(userId),
  });
});

const updateSchema = z.object({
  dedicatedRunnerId: z.string().min(1).nullable().optional(),
  /** Plaintext token to store (encrypted); `null` clears it; omitted = unchanged. */
  githubToken: z.string().min(1).max(512).nullable().optional(),
});

projectRunnerSettingsRoutes.put('/:id/runner-settings', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.param('id');
  if (!(await requireOwnedProject(projectId, userId))) {
    return c.json({ error: 'Project not found' }, 404);
  }
  const parsed = await parseJsonBody(c, updateSchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const body = parsed.value;

  if (body.dedicatedRunnerId !== undefined) {
    const result = await setProjectDedicatedRunner(projectId, userId, body.dedicatedRunnerId);
    if (!result.ok) return c.json({ error: 'Runner not found' }, 404);
    audit({
      action: 'project.runner_binding_changed',
      actorId: userId,
      detail: `project ${projectId} dedicated runner → ${body.dedicatedRunnerId ?? 'general'}`,
      meta: {
        projectId,
        dedicatedRunnerId: body.dedicatedRunnerId,
        revoked: result.revokedRunnerIds,
      },
    });
    await stopProjectSessionsOnRunners(
      c.env?.runnerRequests,
      userId,
      projectId,
      result.revokedRunnerIds,
    );
  }
  if (body.githubToken !== undefined) {
    await setProjectGithubToken(projectId, body.githubToken);
  }
  return c.json(await getProjectRunnerSettings(projectId));
});

projectRunnerSettingsRoutes.post('/:id/runner-grants/:runnerId', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.param('id');
  if (!(await requireOwnedProject(projectId, userId))) {
    return c.json({ error: 'Project not found' }, 404);
  }
  if (!(await grantProjectRunner(projectId, userId, c.req.param('runnerId')))) {
    return c.json({ error: 'Runner not found' }, 404);
  }
  return c.json(await getProjectRunnerSettings(projectId));
});

projectRunnerSettingsRoutes.delete('/:id/runner-grants/:runnerId', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.param('id');
  const runnerId = c.req.param('runnerId');
  if (!(await requireOwnedProject(projectId, userId))) {
    return c.json({ error: 'Project not found' }, 404);
  }
  const result = await revokeProjectRunner(projectId, userId, runnerId);
  if (!result.ok) return c.json({ error: 'Project not found' }, 404);
  if (result.lostAccess) {
    await stopProjectSessionsOnRunners(c.env?.runnerRequests, userId, projectId, [runnerId]);
  }
  return c.json(await getProjectRunnerSettings(projectId));
});
