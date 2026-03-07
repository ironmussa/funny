/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 */

import { AbbacchioClient } from '@abbacchio/transport';
import { Hono } from 'hono';

import { getTelemetryConfig } from '../lib/telemetry-config.js';
import type { HonoEnv } from '../types/hono-env.js';

export const logRoutes = new Hono<HonoEnv>();

const VALID_LEVELS: Record<string, number> = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const cfg = getTelemetryConfig();

const client = new AbbacchioClient({
  endpoint: cfg.endpoint,
  serviceName: cfg.browserServiceName,
  enabled: cfg.enabled,
});

/**
 * POST /api/logs
 * Receives logs from the frontend and forwards them to the OTLP backend.
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

    const level = VALID_LEVELS[entry.level] ?? 30;
    client.add({
      level,
      msg: entry.message,
      time: Date.now(),
      'log.source': 'browser',
      'user.id': userId,
      ...entry.attributes,
    });
  }

  return c.json({ ok: true });
});
