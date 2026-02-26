import { Hono } from 'hono';

import { getOverview, getTimeline } from '../services/analytics-service.js';
import type { HonoEnv } from '../types/hono-env.js';

export const analyticsRoutes = new Hono<HonoEnv>();

// GET /api/analytics/overview?projectId=xxx&timeRange=month&tz=300
analyticsRoutes.get('/overview', (c) => {
  const userId = c.get('userId') as string;
  const result = getOverview({
    userId,
    projectId: c.req.query('projectId'),
    timeRange: c.req.query('timeRange'),
    offsetMinutes: parseInt(c.req.query('tz') || '0', 10) || 0,
  });
  return c.json(result);
});

// GET /api/analytics/timeline?projectId=xxx&timeRange=month&groupBy=week&tz=300
analyticsRoutes.get('/timeline', (c) => {
  const userId = c.get('userId') as string;
  const result = getTimeline({
    userId,
    projectId: c.req.query('projectId'),
    timeRange: c.req.query('timeRange'),
    groupBy: c.req.query('groupBy') || 'day',
    offsetMinutes: parseInt(c.req.query('tz') || '0', 10) || 0,
  });
  return c.json(result);
});
