/**
 * @domain subdomain: Analytics
 * @domain subdomain-type: generic
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: AnalyticsService
 */

import { Hono } from 'hono';

import { getOverview, getTimeline } from '../services/analytics-service.js';
import type { HonoEnv } from '../types/hono-env.js';

export const analyticsRoutes = new Hono<HonoEnv>();

// GET /api/analytics/overview?projectId=xxx&timeRange=month&tz=300
analyticsRoutes.get('/overview', async (c) => {
  const userId = c.get('userId') as string;
  const result = await getOverview({
    userId,
    projectId: c.req.query('projectId'),
    timeRange: c.req.query('timeRange'),
    offsetMinutes: parseInt(c.req.query('tz') || '0', 10) || 0,
  });
  return c.json(result);
});

// GET /api/analytics/timeline?projectId=xxx&timeRange=month&groupBy=week&tz=300
analyticsRoutes.get('/timeline', async (c) => {
  const userId = c.get('userId') as string;
  const result = await getTimeline({
    userId,
    projectId: c.req.query('projectId'),
    timeRange: c.req.query('timeRange'),
    groupBy: c.req.query('groupBy') || 'day',
    offsetMinutes: parseInt(c.req.query('tz') || '0', 10) || 0,
  });
  return c.json(result);
});
