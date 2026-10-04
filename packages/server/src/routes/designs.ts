/**
 * Design routes for the central server.
 *
 * DB CRUD (list, get, create, delete) is handled here.
 * Folder creation on disk is done by the runtime, then persisted here.
 *
 * Two route groups are exported:
 * - designProjectRoutes: mounted under /api/projects (list/create designs under a project)
 * - designRoutes: mounted under /api/designs (operations by design ID)
 */

import type { DesignFidelity, DesignType } from '@funny/shared';
import { createDesignRepository } from '@funny/shared/repositories';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';

import { db, dbAll, dbGet, dbRun } from '../db/index.js';
import * as schema from '../db/schema.js';
import { requireProjectAccess } from '../lib/server-authorizer.js';
import type { ServerEnv } from '../lib/types.js';

const designRepo = createDesignRepository({ db, schema: schema as any, dbAll, dbGet, dbRun });

const VALID_TYPES: DesignType[] = ['prototype', 'slides', 'template', 'other'];
const VALID_FIDELITIES: DesignFidelity[] = ['wireframe', 'high'];

// ── Routes nested under /api/projects/:id/designs ───────────────

export const designProjectRoutes = new Hono<ServerEnv>();

// GET /api/projects/:id/designs — list designs for a project
designProjectRoutes.get('/:id/designs', requireProjectAccess('view'), async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId') as string;

  const designs = await designRepo.listDesigns(projectId, userId);
  return c.json(designs);
});

// POST /api/projects/:id/designs — create a new design row
designProjectRoutes.post('/:id/designs', requireProjectAccess('view'), async (c) => {
  const projectId = c.req.param('id');
  const userId = c.get('userId') as string;

  const body = await c.req.json<{
    name: string;
    type: DesignType;
    fidelity?: DesignFidelity | null;
    speakerNotes?: boolean;
  }>();

  const name = (body.name ?? '').trim();
  if (!name) return c.json({ error: 'name is required' }, 400);
  if (name.length > 200) return c.json({ error: 'name must be ≤ 200 chars' }, 400);

  if (!VALID_TYPES.includes(body.type)) {
    return c.json({ error: `type must be one of: ${VALID_TYPES.join(', ')}` }, 400);
  }
  if (body.fidelity != null && !VALID_FIDELITIES.includes(body.fidelity)) {
    return c.json({ error: `fidelity must be one of: ${VALID_FIDELITIES.join(', ')}` }, 400);
  }

  const id = nanoid();
  const folderPath = `designs/${id}`;
  const design = await designRepo.createDesign({
    id,
    projectId,
    userId,
    name,
    type: body.type,
    fidelity: body.fidelity ?? null,
    speakerNotes: !!body.speakerNotes,
    folderPath,
  });

  return c.json(design, 201);
});

// ── Routes at /api/designs/:id ──────────────────────────────────

export const designRoutes = new Hono<ServerEnv>();

// GET /api/designs/:id — get design details
designRoutes.get('/:id', async (c) => {
  const designId = c.req.param('id');
  const userId = c.get('userId') as string;

  const design = await designRepo.getDesign(designId);
  if (!design) return c.json({ error: 'Design not found' }, 404);
  if (design.userId !== userId) {
    return c.json({ error: 'Access denied' }, 403);
  }

  return c.json(design);
});

// DELETE /api/designs/:id — delete a design row (folder cleanup is best-effort and runtime-side)
designRoutes.delete('/:id', async (c) => {
  const designId = c.req.param('id');
  const userId = c.get('userId') as string;

  const design = await designRepo.getDesign(designId);
  if (!design) return c.json({ error: 'Design not found' }, 404);
  if (design.userId !== userId) {
    return c.json({ error: 'Access denied' }, 403);
  }

  await designRepo.deleteDesign(designId);
  return c.json({ ok: true });
});
