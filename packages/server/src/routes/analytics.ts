/**
 * @domain subdomain: Analytics
 * @domain subdomain-type: generic
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: AnalyticsService
 *
 * The logic lives in `trpc/ports/insights.ts`, shared with the `analytics` tRPC
 * procedures (openspec adopt-trpc-browser-api).
 */

import { analyticsOverviewQuery, analyticsTimelineQuery } from '@funny/shared/contracts/analytics';
import { Hono } from 'hono';

import type { ServerEnv } from '../lib/types.js';
import { analyticsPort as port } from '../trpc/ports/insights.js';
import { answerJson } from '../trpc/reply.js';
import { parseQuery } from '../validation/request.js';

export const analyticsRoutes = new Hono<ServerEnv>();

// GET /api/analytics/overview?projectId=xxx&timeRange=month&tz=300
analyticsRoutes.get('/overview', async (c) => {
  const parsed = parseQuery(c, analyticsOverviewQuery);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  return answerJson(c, port.overview(c.get('userId') as string, parsed.value));
});

// GET /api/analytics/timeline?projectId=xxx&timeRange=month&groupBy=week&tz=300
analyticsRoutes.get('/timeline', async (c) => {
  const parsed = parseQuery(c, analyticsTimelineQuery);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  return answerJson(c, port.timeline(c.get('userId') as string, parsed.value));
});
