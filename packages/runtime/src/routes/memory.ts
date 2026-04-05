/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain type: route-handler
 * @domain layer: presentation
 *
 * REST API routes for memory operations.
 * Mounted under /api/projects/:projectId/memory
 */

import {
  getPaisleyPark,
  type SearchFilters,
  type StorageConfig,
  type TimelineOptions,
} from '@funny/memory';
import { Hono } from 'hono';

import { getServices } from '../services/service-registry.js';

export const memoryRoutes = new Hono();

/** Build a StorageConfig from a project ID + name */
function memoryConfig(projectId: string, projectName: string): StorageConfig {
  const url = process.env.MEMORY_DB_URL ?? `file:${projectId}-memory.db`;
  return {
    url,
    syncUrl: process.env.MEMORY_SYNC_URL,
    authToken: process.env.MEMORY_AUTH_TOKEN,
    projectId,
    projectName,
  };
}

// ─── GET /recall ───────────────────────────────────────

memoryRoutes.get('/:projectId/memory/recall', async (c) => {
  const projectId = c.req.param('projectId');
  const query = c.req.query('query') ?? '';
  const limit = Number(c.req.query('limit')) || 10;
  const scope = (c.req.query('scope') as any) ?? 'all';
  const minConfidence = Number(c.req.query('minConfidence')) || 0.5;

  const project = await getServices().projects.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  try {
    const pp = getPaisleyPark(memoryConfig(projectId, project.name));
    const result = await pp.recall(query, { limit, scope, minConfidence });
    return c.json(result);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// ─── POST /facts ───────────────────────────────────────

memoryRoutes.post('/:projectId/memory/facts', async (c) => {
  const projectId = c.req.param('projectId');
  const body = await c.req.json<{
    content: string;
    type: string;
    tags?: string[];
    confidence?: number;
    relatedTo?: string[];
    sourceAgent?: string;
    sourceOperator?: string;
  }>();

  if (!body.content || !body.type) {
    return c.json({ error: 'content and type are required' }, 400);
  }

  const project = await getServices().projects.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  try {
    const pp = getPaisleyPark(memoryConfig(projectId, project.name));
    const fact = await pp.add(body.content, {
      type: body.type as any,
      tags: body.tags,
      confidence: body.confidence,
      relatedTo: body.relatedTo,
      sourceAgent: body.sourceAgent,
      sourceOperator: body.sourceOperator,
    });
    return c.json(fact, 201);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// ─── PATCH /facts/:factId/invalidate ───────────────────

memoryRoutes.patch('/:projectId/memory/facts/:factId/invalidate', async (c) => {
  const projectId = c.req.param('projectId');
  const factId = c.req.param('factId');
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}) as { reason?: string });

  const project = await getServices().projects.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  try {
    const pp = getPaisleyPark(memoryConfig(projectId, project.name));
    await pp.invalidate(factId, body.reason);
    return c.json({ ok: true });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// ─── PATCH /facts/:factId/evolve ───────────────────────

memoryRoutes.patch('/:projectId/memory/facts/:factId/evolve', async (c) => {
  const projectId = c.req.param('projectId');
  const factId = c.req.param('factId');
  const body = await c.req.json<{ update: string }>();

  if (!body.update) return c.json({ error: 'update is required' }, 400);

  const project = await getServices().projects.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  try {
    const pp = getPaisleyPark(memoryConfig(projectId, project.name));
    const fact = await pp.evolve(factId, body.update);
    return c.json(fact);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// ─── GET /search ───────────────────────────────────────

memoryRoutes.get('/:projectId/memory/search', async (c) => {
  const projectId = c.req.param('projectId');
  const query = c.req.query('query') ?? '';
  const type = c.req.query('type');
  const tags = c.req.query('tags')?.split(',').filter(Boolean);
  const validAt = c.req.query('validAt');
  const minConfidence = Number(c.req.query('minConfidence')) || undefined;

  const project = await getServices().projects.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  try {
    const pp = getPaisleyPark(memoryConfig(projectId, project.name));
    const filters: SearchFilters = {};
    if (type) filters.type = type as any;
    if (tags?.length) filters.tags = tags;
    if (validAt) filters.validAt = validAt;
    if (minConfidence) filters.minConfidence = minConfidence;

    const facts = await pp.search(query, filters);
    return c.json({ facts });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// ─── GET /timeline ─────────────────────────────────────

memoryRoutes.get('/:projectId/memory/timeline', async (c) => {
  const projectId = c.req.param('projectId');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const type = c.req.query('type');

  const project = await getServices().projects.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  try {
    const pp = getPaisleyPark(memoryConfig(projectId, project.name));
    const options: TimelineOptions = { includeInvalidated: true };
    if (from) options.from = from;
    if (to) options.to = to;
    if (type) options.type = type as any;

    const facts = await pp.timeline(options);
    return c.json({ facts });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// ─── GET /operators/:operatorId ────────────────────────

memoryRoutes.get('/:projectId/memory/operators/:operatorId', async (c) => {
  const projectId = c.req.param('projectId');
  const operatorId = c.req.param('operatorId');

  const project = await getServices().projects.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  try {
    const pp = getPaisleyPark(memoryConfig(projectId, project.name));
    const result = await pp.recall('', { limit: 0, forOperator: operatorId });
    return c.json({ operator: operatorId, context: result.formattedContext });
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});

// ─── POST /gc ──────────────────────────────────────────

memoryRoutes.post('/:projectId/memory/gc', async (c) => {
  const projectId = c.req.param('projectId');

  const project = await getServices().projects.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  try {
    const { runGC } = await import('@funny/memory');
    const result = await runGC(memoryConfig(projectId, project.name));
    if (result.isErr()) return c.json({ error: result.error }, 500);
    return c.json(result.value);
  } catch (e) {
    return c.json({ error: String(e) }, 500);
  }
});
