/**
 * Issue factory routes (change issue-factory): the per-(project, user) factory
 * settings and its run list. Settings reads/writes are scoped to project access
 * by the service; runs are read-only here (the watcher writes them, phase 2+).
 */
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { audit } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import {
  createFactoryRunsRepository,
  type FactoryRunsError,
} from '../services/factory/factory-runs.js';
import {
  createFactorySettingsService,
  type FactorySettingsError,
} from '../services/factory/factory-settings.js';
import { rescheduleFactory } from '../services/factory/factory-watcher.js';
import { projectAccessRefusal } from './project-access-response.js';

const saveSchema = z
  .object({
    enabled: z.boolean(),
    label: z.string().trim().min(1).max(64).optional(),
    flowName: z.string().trim().min(1).max(64).optional(),
    maxConcurrent: z.number().int().min(1).max(20).optional(),
  })
  .strict();

function respondSettings(c: Context<ServerEnv>, error: FactorySettingsError) {
  switch (error.kind) {
    case 'not-found':
    case 'forbidden':
      return projectAccessRefusal(c, error);
    case 'invalid':
      return c.json({ error: error.message, code: error.kind }, 400);
    case 'storage':
      log.error('Factory settings storage failure', { namespace: 'factory', error: error.message });
      return c.json({ error: 'Internal error', code: error.kind }, 500);
  }
}

function respondRuns(c: Context<ServerEnv>, error: FactoryRunsError) {
  log.error('Factory runs storage failure', { namespace: 'factory', error: error.message });
  return c.json({ error: 'Internal error', code: error.kind }, 500);
}

export function createFactoryRoutes() {
  const settings = createFactorySettingsService();
  const runs = createFactoryRunsRepository();
  const routes = new Hono<ServerEnv>();

  routes.get('/projects/:projectId', async (c) => {
    const result = await settings.get(c.get('userId'), c.req.param('projectId'));
    return result.isOk() ? c.json({ settings: result.value }) : respondSettings(c, result.error);
  });

  routes.put('/projects/:projectId', async (c) => {
    const parsed = saveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid factory settings', code: 'invalid' }, 400);
    const userId = c.get('userId');
    const projectId = c.req.param('projectId');
    const result = await settings.save(userId, projectId, parsed.data);
    if (result.isErr()) return respondSettings(c, result.error);
    audit({
      action: 'factory.settings_set',
      actorId: userId,
      detail: `Project ${projectId} factory ${result.value.enabled ? 'enabled' : 'disabled'}`,
      meta: { projectId, enabled: result.value.enabled, label: result.value.label },
    });
    // Pick up the change in the running watcher without a restart (enable starts
    // polling; disable stops it). Best-effort — the watcher may not be running.
    const factoryId = await settings.factoryId(userId, projectId);
    if (factoryId.isOk() && factoryId.value) {
      await rescheduleFactory(factoryId.value).catch((error: unknown) =>
        log.error('Failed to reschedule factory', {
          namespace: 'factory',
          projectId,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
    return c.json({ settings: result.value });
  });

  routes.get('/projects/:projectId/runs', async (c) => {
    const userId = c.get('userId');
    const projectId = c.req.param('projectId');
    const idResult = await settings.factoryId(userId, projectId);
    if (idResult.isErr()) return respondSettings(c, idResult.error);
    const factoryId = idResult.value;
    if (!factoryId) return c.json({ runs: [] });
    const result = await runs.list(factoryId);
    return result.isOk() ? c.json({ runs: result.value }) : respondRuns(c, result.error);
  });

  return routes;
}
