/**
 * Agent Template REST routes.
 *
 * Templates are global (per-user, not per-project) and only apply when the
 * harness/provider is `deepagent`. The logic lives in
 * `trpc/ports/agent-templates.ts`, shared with the `agentTemplates` tRPC
 * procedures (openspec adopt-trpc-browser-api).
 */

import {
  agentTemplateBody,
  updateAgentTemplateBody,
} from '@funny/shared/contracts/agent-templates';
import { Hono, type Context } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import { agentTemplatesPort as port } from '../trpc/ports/agent-templates.js';
import { answerJson } from '../trpc/reply.js';
import { parseJsonBody } from '../validation/request.js';

export const agentTemplateRoutes = new Hono<ServerEnv>();

const userIdOf = (c: Context<ServerEnv>) => c.get('userId') as string;

// GET /api/agent-templates — own templates + shared ones
agentTemplateRoutes.get('/', (c) => answerJson(c, port.list(userIdOf(c))));

// GET /api/agent-templates/stats/usage — thread count per template
agentTemplateRoutes.get('/stats/usage', (c) => answerJson(c, port.usageStats(userIdOf(c))));

// GET /api/agent-templates/:id
agentTemplateRoutes.get('/:id', (c) => answerJson(c, port.get(userIdOf(c), c.req.param('id'))));

// POST /api/agent-templates
agentTemplateRoutes.post('/', async (c) => {
  const parsed = await parseJsonBody(c, agentTemplateBody);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  return answerJson(c, port.create(userIdOf(c), parsed.value), 201);
});

// PATCH /api/agent-templates/:id — owner only (404 / 403 before the body is read)
agentTemplateRoutes.patch('/:id', async (c) => {
  const id = c.req.param('id');
  const refused = await port.authorizeWrite(userIdOf(c), id);
  if (refused) return c.json({ error: refused.message }, refused.status as 403 | 404);

  const parsed = await parseJsonBody(c, updateAgentTemplateBody);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  return answerJson(c, port.update(userIdOf(c), id, parsed.value));
});

// DELETE /api/agent-templates/:id — owner only
agentTemplateRoutes.delete('/:id', async (c) => {
  const id = c.req.param('id');
  const refused = await port.authorizeWrite(userIdOf(c), id);
  if (refused) return c.json({ error: refused.message }, refused.status as 403 | 404);
  return answerJson(c, port.remove(userIdOf(c), id));
});

// POST /api/agent-templates/:id/duplicate — a private copy (built-ins too)
agentTemplateRoutes.post('/:id/duplicate', (c) =>
  answerJson(c, port.duplicate(userIdOf(c), c.req.param('id')), 201),
);
