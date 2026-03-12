/**
 * @domain subdomain: Memory System (Paisley Park)
 * @domain type: route-handler
 * @domain layer: presentation
 *
 * REST API routes for memory operations.
 * Mounted under /api/projects/:projectId/memory
 */

import { getPaisleyPark } from '@funny/memory';
import type { AddOptions, SearchFilters, TimelineOptions } from '@funny/shared';
import { Hono } from 'hono';

import * as pm from '../services/project-manager.js';

export const memoryRoutes = new Hono();

// ─── GET /recall ────────────────────────────────────────

memoryRoutes.get('/:projectId/memory/recall', async (c) => {
  const projectId = c.req.param('projectId');
  const query = c.req.query('query') ?? '';
  const limit = Number(c.req.query('limit')) || 10;
  const scope = (c.req.query('scope') as any) ?? 'all';
  const minConfidence = Number(c.req.query('minConfidence')) || 0.5;

  const project = await pm.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const pp = getPaisleyPark(projectId, project.name);
  const result = await pp.recall(query, { limit, scope, minConfidence });

  if (result.isErr()) return c.json({ error: result.error }, 500);
  return c.json(result.value);
});

// ─── POST /facts ────────────────────────────────────────

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

  const project = await pm.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const pp = getPaisleyPark(projectId, project.name);
  const result = await pp.add(body.content, {
    type: body.type as any,
    tags: body.tags,
    confidence: body.confidence,
    relatedTo: body.relatedTo,
    sourceAgent: body.sourceAgent,
    sourceOperator: body.sourceOperator,
  });

  if (result.isErr()) return c.json({ error: result.error }, 500);
  return c.json(result.value, 201);
});

// ─── PATCH /facts/:factId/invalidate ────────────────────

memoryRoutes.patch('/:projectId/memory/facts/:factId/invalidate', async (c) => {
  const projectId = c.req.param('projectId');
  const factId = c.req.param('factId');
  const body = await c.req.json<{ reason?: string }>().catch(() => ({}));

  const project = await pm.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const pp = getPaisleyPark(projectId, project.name);
  const result = await pp.invalidate(factId, body.reason);

  if (result.isErr()) return c.json({ error: result.error }, 500);
  return c.json({ ok: true });
});

// ─── PATCH /facts/:factId/evolve ────────────────────────

memoryRoutes.patch('/:projectId/memory/facts/:factId/evolve', async (c) => {
  const projectId = c.req.param('projectId');
  const factId = c.req.param('factId');
  const body = await c.req.json<{ update: string }>();

  if (!body.update) return c.json({ error: 'update is required' }, 400);

  const project = await pm.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const pp = getPaisleyPark(projectId, project.name);
  const result = await pp.evolve(factId, body.update);

  if (result.isErr()) return c.json({ error: result.error }, 500);
  return c.json(result.value);
});

// ─── GET /search ────────────────────────────────────────

memoryRoutes.get('/:projectId/memory/search', async (c) => {
  const projectId = c.req.param('projectId');
  const query = c.req.query('query') ?? '';
  const type = c.req.query('type');
  const tags = c.req.query('tags')?.split(',').filter(Boolean);
  const validAt = c.req.query('validAt');
  const minConfidence = Number(c.req.query('minConfidence')) || undefined;

  const project = await pm.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const pp = getPaisleyPark(projectId, project.name);
  const filters: SearchFilters = {};
  if (type) filters.type = type as any;
  if (tags?.length) filters.tags = tags;
  if (validAt) filters.validAt = validAt;
  if (minConfidence) filters.minConfidence = minConfidence;

  const result = await pp.search(query, filters);

  if (result.isErr()) return c.json({ error: result.error }, 500);
  return c.json({ facts: result.value });
});

// ─── GET /timeline ──────────────────────────────────────

memoryRoutes.get('/:projectId/memory/timeline', async (c) => {
  const projectId = c.req.param('projectId');
  const from = c.req.query('from');
  const to = c.req.query('to');
  const type = c.req.query('type');

  const project = await pm.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const pp = getPaisleyPark(projectId, project.name);
  const options: TimelineOptions = { includeInvalidated: true };
  if (from) options.from = from;
  if (to) options.to = to;
  if (type) options.type = type as any;

  const result = await pp.timeline(options);

  if (result.isErr()) return c.json({ error: result.error }, 500);
  return c.json({ facts: result.value });
});

// ─── GET /operators/:operatorId ──────────────────────────

memoryRoutes.get('/:projectId/memory/operators/:operatorId', async (c) => {
  const projectId = c.req.param('projectId');
  const operatorId = c.req.param('operatorId');

  const project = await pm.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const pp = getPaisleyPark(projectId, project.name);
  // Use recall with forOperator to get operator context
  const result = await pp.recall('', { limit: 0, forOperator: operatorId });
  if (result.isErr()) return c.json({ error: result.error }, 500);

  return c.json({ operator: operatorId, context: result.value.formattedContext });
});

// ─── POST /gc ───────────────────────────────────────────

memoryRoutes.post('/:projectId/memory/gc', async (c) => {
  const projectId = c.req.param('projectId');

  const project = await pm.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  // Lazy import to avoid circular deps
  const { runGC } = await import('@funny/memory');
  const result = await runGC(projectId, project.name);

  if (result.isErr()) return c.json({ error: result.error }, 500);
  return c.json(result.value);
});
