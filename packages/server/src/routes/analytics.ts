/**
 * @domain subdomain: Analytics
 * @domain subdomain-type: generic
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: AnalyticsService
 */

import { Hono } from 'hono';
import { z } from 'zod';

import type { ServerEnv } from '../lib/types.js';
import { getOverview, getTimeline } from '../services/analytics-service.js';
import { parseQuery } from '../validation/request.js';

export const analyticsRoutes = new Hono<ServerEnv>();

const overviewQuerySchema = z.object({
  projectId: z.string().optional(),
  timeRange: z.string().optional(),
  tz: z.coerce.number().default(0),
});

const timelineQuerySchema = overviewQuerySchema.extend({
  groupBy: z.string().default('day'),
});

// GET /api/analytics/overview?projectId=xxx&timeRange=month&tz=300
analyticsRoutes.get('/overview', async (c) => {
  const userId = c.get('userId') as string;
  const parsed = parseQuery(c, overviewQuerySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const query = parsed.value;

  const result = await getOverview({
    userId,
    projectId: query.projectId,
    timeRange: query.timeRange,
    offsetMinutes: query.tz || 0,
  });
  return c.json(result);
});

// GET /api/analytics/timeline?projectId=xxx&timeRange=month&groupBy=week&tz=300
analyticsRoutes.get('/timeline', async (c) => {
  const userId = c.get('userId') as string;
  const parsed = parseQuery(c, timelineQuerySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const query = parsed.value;

  const result = await getTimeline({
    userId,
    projectId: query.projectId,
    timeRange: query.timeRange,
    groupBy: query.groupBy,
    offsetMinutes: query.tz || 0,
  });
  return c.json(result);
});
