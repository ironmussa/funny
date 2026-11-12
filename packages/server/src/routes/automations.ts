/**
 * Automation REST routes for the central server.
 *
 * The logic lives in `trpc/ports/automations.ts`, shared with the
 * `automations` tRPC procedures (openspec change adopt-trpc-browser-api); these
 * routes stay for REST consumers outside the web client while the two coexist.
 */

import { automationsContract as contract } from '@funny/shared/contracts/automations';
import { Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import { automationsPort as port } from '../trpc/ports/automations.js';
import { answer } from '../trpc/reply.js';
import { serveEndpoint } from '../validation/endpoint.js';

export const automationRoutes = new Hono<ServerEnv>();

// Every endpoint requires a user: `serveEndpoint` refuses 401 without one.

// GET /api/automations/inbox?projectId=xxx&triageStatus=xxx — must be before /:id
serveEndpoint(automationRoutes, contract.inbox, ({ userId, query }) =>
  answer(port.inbox(userId, query)),
);

// GET /api/automations?projectId=xxx
serveEndpoint(automationRoutes, contract.list, ({ userId, query }) =>
  answer(port.list(userId, query)),
);

// GET /api/automations/:id
serveEndpoint(automationRoutes, contract.get, ({ userId, params }) =>
  answer(port.get(userId, params.id)),
);

// POST /api/automations
serveEndpoint(automationRoutes, contract.create, ({ userId, body }) =>
  answer(port.create(userId, body), 201),
);

// PATCH /api/automations/:id
serveEndpoint(automationRoutes, contract.update, ({ userId, params, body }) =>
  answer(port.update(userId, params.id, body)),
);

// DELETE /api/automations/:id
serveEndpoint(automationRoutes, contract.remove, ({ userId, params }) =>
  answer(port.remove(userId, params.id)),
);

// POST /api/automations/:id/trigger — run now on the owner's runner
serveEndpoint(automationRoutes, contract.trigger, ({ userId, params }) =>
  answer(port.trigger(userId, params.id)),
);

// GET /api/automations/:id/runs
serveEndpoint(automationRoutes, contract.runs, ({ userId, params }) =>
  answer(port.runs(userId, params.id)),
);

// PATCH /api/automations/runs/:runId/triage
serveEndpoint(automationRoutes, contract.triageRun, ({ userId, params, body }) =>
  answer(port.triageRun(userId, params.runId, body.triageStatus)),
);
