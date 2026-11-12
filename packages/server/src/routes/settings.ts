/**
 * Settings REST routes for the central server.
 *
 * SMTP is instance-level and requires admin role. Agent execution profiles are
 * user-scoped settings and use the authenticated user id. The logic lives in
 * `trpc/ports/settings.ts`, shared with the `settings` tRPC procedures (openspec
 * adopt-trpc-browser-api); these routes stay for REST consumers outside the web
 * client.
 */

import {
  createAgentExecutionProfileSchema,
  updateAgentExecutionProfileSchema,
  updateProjectAgentProfileBindingSchema,
} from '@funny/shared';
import type { SmtpSettingsRequest } from '@funny/shared/contracts/settings';
import { Hono, type Context } from 'hono';

import { requireProjectAccess } from '../lib/server-authorizer.js';
import type { ServerEnv } from '../lib/types.js';
import { requireAdmin } from '../middleware/auth.js';
import { settingsPort as port } from '../trpc/ports/settings.js';
import { answerJson } from '../trpc/reply.js';
import { parseJsonBody } from '../validation/request.js';

export const settingsRoutes = new Hono<ServerEnv>();

const userIdOf = (c: Context<ServerEnv>) => c.get('userId') as string;

// ── Agent execution profiles ────────────────────────────────────

// GET /api/settings/agent-profiles — list current user's execution profiles
settingsRoutes.get('/agent-profiles', (c) => answerJson(c, port.listAgentProfiles(userIdOf(c))));

// POST /api/settings/agent-profiles — create current user's execution profile
settingsRoutes.post('/agent-profiles', async (c) => {
  const parsed = await parseJsonBody(c, createAgentExecutionProfileSchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  return answerJson(c, port.createAgentProfile(userIdOf(c), parsed.value), 201);
});

// PATCH /api/settings/agent-profiles/:id — update current user's execution profile
settingsRoutes.patch('/agent-profiles/:id', async (c) => {
  const parsed = await parseJsonBody(c, updateAgentExecutionProfileSchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  return answerJson(c, port.updateAgentProfile(userIdOf(c), c.req.param('id'), parsed.value));
});

// DELETE /api/settings/agent-profiles/:id — delete current user's execution profile
settingsRoutes.delete('/agent-profiles/:id', (c) =>
  answerJson(c, port.deleteAgentProfile(userIdOf(c), c.req.param('id'))),
);

// GET /api/settings/agent-profiles/projects/:projectId — read current user's project binding
settingsRoutes.get(
  '/agent-profiles/projects/:projectId',
  requireProjectAccess('view', { param: 'projectId' }),
  (c) => answerJson(c, port.getProjectBinding(userIdOf(c), c.req.param('projectId'))),
);

// PUT /api/settings/agent-profiles/projects/:projectId — set/clear current user's binding
settingsRoutes.put(
  '/agent-profiles/projects/:projectId',
  requireProjectAccess('view', { param: 'projectId' }),
  async (c) => {
    const parsed = await parseJsonBody(c, updateProjectAgentProfileBindingSchema);
    if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
    return answerJson(
      c,
      port.setProjectBinding(userIdOf(c), c.req.param('projectId'), parsed.value.profileId),
    );
  },
);

// ── SMTP settings ────────────────────────────────────────────────

// GET /api/settings/smtp — get SMTP settings (never exposes password)
settingsRoutes.get('/smtp', requireAdmin, (c) => answerJson(c, port.getSmtp()));

// PUT /api/settings/smtp — save SMTP config
settingsRoutes.put('/smtp', requireAdmin, async (c) =>
  answerJson(c, port.saveSmtp(await c.req.json<SmtpSettingsRequest>())),
);

// POST /api/settings/smtp/test — send a test email using stored SMTP settings
settingsRoutes.post('/smtp/test', requireAdmin, (c) => answerJson(c, port.testSmtp()));
