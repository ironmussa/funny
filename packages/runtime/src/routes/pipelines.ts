/**
 * @domain subdomain: Pipeline
 * @domain subdomain-type: core
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: PipelineOrchestrator
 *
 * REST API routes for pipeline CRUD and run management.
 */

import { Hono } from 'hono';

import {
  createPipeline,
  deletePipeline,
  getPipelineById,
  getPipelinesByProject,
  getRunsForThread,
  updatePipeline,
} from '../services/pipeline-manager.js';

export const pipelineRoutes = new Hono();

// ── List pipelines for a project ────────────────────────────

pipelineRoutes.get('/project/:projectId', async (c) => {
  const { projectId } = c.req.param();
  const rows = await getPipelinesByProject(projectId);
  return c.json(rows);
});

// ── Get a single pipeline ───────────────────────────────────

pipelineRoutes.get('/:id', async (c) => {
  const { id } = c.req.param();
  const pipeline = await getPipelineById(id);
  if (!pipeline) return c.json({ error: 'Pipeline not found' }, 404);
  return c.json(pipeline);
});

// ── Create a pipeline ───────────────────────────────────────

pipelineRoutes.post('/', async (c) => {
  const userId = c.get('userId') as string;
  const body = await c.req.json();

  if (!body.projectId || !body.name) {
    return c.json({ error: 'projectId and name are required' }, 400);
  }

  const id = await createPipeline({
    projectId: body.projectId,
    userId,
    name: body.name,
    reviewModel: body.reviewModel,
    fixModel: body.fixModel,
    maxIterations: body.maxIterations,
    precommitFixEnabled: body.precommitFixEnabled,
    precommitFixModel: body.precommitFixModel,
    precommitFixMaxIterations: body.precommitFixMaxIterations,
    reviewerPrompt: body.reviewerPrompt,
    correctorPrompt: body.correctorPrompt,
    precommitFixerPrompt: body.precommitFixerPrompt,
    commitMessagePrompt: body.commitMessagePrompt,
    testEnabled: body.testEnabled,
    testCommand: body.testCommand,
    testFixEnabled: body.testFixEnabled,
    testFixModel: body.testFixModel,
    testFixMaxIterations: body.testFixMaxIterations,
    testFixerPrompt: body.testFixerPrompt,
  });

  const pipeline = await getPipelineById(id);
  return c.json(pipeline, 201);
});

// ── Update a pipeline ───────────────────────────────────────

pipelineRoutes.patch('/:id', async (c) => {
  const { id } = c.req.param();
  const body = await c.req.json();

  const existing = await getPipelineById(id);
  if (!existing) return c.json({ error: 'Pipeline not found' }, 404);

  const updates: Record<string, unknown> = {};
  if (body.name !== undefined) updates.name = body.name;
  if (body.enabled !== undefined) updates.enabled = body.enabled ? 1 : 0;
  if (body.reviewModel !== undefined) updates.reviewModel = body.reviewModel;
  if (body.fixModel !== undefined) updates.fixModel = body.fixModel;
  if (body.maxIterations !== undefined) updates.maxIterations = body.maxIterations;
  if (body.precommitFixEnabled !== undefined)
    updates.precommitFixEnabled = body.precommitFixEnabled ? 1 : 0;
  if (body.precommitFixModel !== undefined) updates.precommitFixModel = body.precommitFixModel;
  if (body.precommitFixMaxIterations !== undefined)
    updates.precommitFixMaxIterations = body.precommitFixMaxIterations;
  if (body.reviewerPrompt !== undefined) updates.reviewerPrompt = body.reviewerPrompt || null;
  if (body.correctorPrompt !== undefined) updates.correctorPrompt = body.correctorPrompt || null;
  if (body.precommitFixerPrompt !== undefined)
    updates.precommitFixerPrompt = body.precommitFixerPrompt || null;
  if (body.commitMessagePrompt !== undefined)
    updates.commitMessagePrompt = body.commitMessagePrompt || null;
  if (body.testEnabled !== undefined) updates.testEnabled = body.testEnabled ? 1 : 0;
  if (body.testCommand !== undefined) updates.testCommand = body.testCommand || null;
  if (body.testFixEnabled !== undefined) updates.testFixEnabled = body.testFixEnabled ? 1 : 0;
  if (body.testFixModel !== undefined) updates.testFixModel = body.testFixModel;
  if (body.testFixMaxIterations !== undefined)
    updates.testFixMaxIterations = body.testFixMaxIterations;
  if (body.testFixerPrompt !== undefined) updates.testFixerPrompt = body.testFixerPrompt || null;

  await updatePipeline(id, updates);
  return c.json(await getPipelineById(id));
});

// ── Delete a pipeline ───────────────────────────────────────

pipelineRoutes.delete('/:id', async (c) => {
  const { id } = c.req.param();
  const existing = await getPipelineById(id);
  if (!existing) return c.json({ error: 'Pipeline not found' }, 404);

  await deletePipeline(id);
  return c.json({ ok: true });
});

// ── Get pipeline runs for a thread ──────────────────────────

pipelineRoutes.get('/runs/thread/:threadId', async (c) => {
  const { threadId } = c.req.param();
  const runs = await getRunsForThread(threadId);
  return c.json(runs);
});
