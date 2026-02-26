import { emitLog } from '@funny/observability';
import { Hono } from 'hono';

import type { HonoEnv } from '../types/hono-env.js';

export const logRoutes = new Hono<HonoEnv>();

const VALID_LEVELS = new Set(['debug', 'info', 'warn', 'error']);

/**
 * POST /api/logs
 * Receives logs from the frontend and forwards them to the OTLP pipeline.
 *
 * Body: { level: "info"|"warn"|"error"|"debug", message: string, attributes?: Record<string, string> }
 * Or batch: { logs: Array<{ level, message, attributes? }> }
 */
logRoutes.post('/', async (c) => {
  const body = await c.req.json();
  const userId = c.get('userId') as string;

  const entries: Array<{ level: string; message: string; attributes?: Record<string, string> }> =
    Array.isArray(body.logs) ? body.logs : [body];

  for (const entry of entries) {
    if (!entry.message || typeof entry.message !== 'string') continue;

    const level = VALID_LEVELS.has(entry.level)
      ? (entry.level as 'debug' | 'info' | 'warn' | 'error')
      : 'info';
    const attrs: Record<string, string> = {
      'log.source': 'browser',
      'user.id': userId,
      ...entry.attributes,
    };

    emitLog(level, entry.message, attrs);
  }

  return c.json({ ok: true });
});
