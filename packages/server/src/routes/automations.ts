import { Hono } from 'hono';
import * as am from '../services/automation-manager.js';
import * as pm from '../services/project-manager.js';
import {
  validate,
  createAutomationSchema,
  updateAutomationSchema,
  updateRunTriageSchema,
} from '../validation/schemas.js';

export const automationRoutes = new Hono();

// GET /api/automations/inbox?projectId=xxx — must be before /:id to avoid conflict
automationRoutes.get('/inbox', (c) => {
  const projectId = c.req.query('projectId');
  const items = am.listPendingReviewRuns(projectId || undefined);
  return c.json(items);
});

// GET /api/automations?projectId=xxx
automationRoutes.get('/', (c) => {
  const projectId = c.req.query('projectId');
  const automations = am.listAutomations(projectId || undefined);
  return c.json(automations);
});

// GET /api/automations/:id
automationRoutes.get('/:id', (c) => {
  const automation = am.getAutomation(c.req.param('id'));
  if (!automation) return c.json({ error: 'Not found' }, 404);
  return c.json(automation);
});

// POST /api/automations
automationRoutes.post('/', async (c) => {
  const raw = await c.req.json();
  const parsed = validate(createAutomationSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);

  // Validate project exists
  const project = pm.getProject(parsed.data.projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const automation = am.createAutomation(parsed.data);
  return c.json(automation, 201);
});

// PATCH /api/automations/:id
automationRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const existing = am.getAutomation(id);
  if (!existing) return c.json({ error: 'Not found' }, 404);

  const raw = await c.req.json();
  const parsed = validate(updateAutomationSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);

  const updates: Record<string, any> = {};
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value !== undefined) {
      if (key === 'enabled') {
        updates.enabled = value ? 1 : 0;
      } else {
        updates[key] = value;
      }
    }
  }

  if (Object.keys(updates).length > 0) {
    am.updateAutomation(id, updates);
  }

  return c.json(am.getAutomation(id));
});

// DELETE /api/automations/:id
automationRoutes.delete('/:id', (c) => {
  const existing = am.getAutomation(c.req.param('id'));
  if (!existing) return c.json({ error: 'Not found' }, 404);
  am.deleteAutomation(c.req.param('id'));
  return c.json({ ok: true });
});

// POST /api/automations/:id/trigger — manual trigger
automationRoutes.post('/:id/trigger', async (c) => {
  const automation = am.getAutomation(c.req.param('id'));
  if (!automation) return c.json({ error: 'Not found' }, 404);

  const { triggerAutomationRun } = await import('../services/automation-scheduler.js');
  await triggerAutomationRun(automation);

  return c.json({ ok: true });
});

// ── Runs ─────────────────────────────────────────────────────────

// GET /api/automations/:id/runs
automationRoutes.get('/:id/runs', (c) => {
  const runs = am.listRuns(c.req.param('id'));
  return c.json(runs);
});

// PATCH /api/automations/runs/:runId/triage
automationRoutes.patch('/runs/:runId/triage', async (c) => {
  const runId = c.req.param('runId');
  const raw = await c.req.json();
  const parsed = validate(updateRunTriageSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);

  am.updateRun(runId, { triageStatus: parsed.data.triageStatus });
  return c.json({ ok: true });
});
