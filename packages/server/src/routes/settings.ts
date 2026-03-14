/**
 * Instance settings routes for the central server.
 *
 * Handles SMTP and other instance-level settings using the server's DB.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/index.js';
import { instanceSettings } from '../db/schema.js';
import type { ServerEnv } from '../lib/types.js';

export const settingsRoutes = new Hono<ServerEnv>();

// ── Instance settings helpers ────────────────────────────────────

async function getSetting(key: string): Promise<string | null> {
  const rows = await db
    .select({ value: instanceSettings.value })
    .from(instanceSettings)
    .where(eq(instanceSettings.key, key));
  return rows[0]?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  const existing = await getSetting(key);
  if (existing !== null) {
    await db
      .update(instanceSettings)
      .set({ value, updatedAt: now })
      .where(eq(instanceSettings.key, key));
  } else {
    await db.insert(instanceSettings).values({ key, value, updatedAt: now });
  }
}

// ── SMTP settings ────────────────────────────────────────────────

// GET /api/settings/smtp — get SMTP settings (never exposes password)
settingsRoutes.get('/smtp', async (c) => {
  const [host, port, user, from, pass] = await Promise.all([
    getSetting('smtp_host'),
    getSetting('smtp_port'),
    getSetting('smtp_user'),
    getSetting('smtp_from'),
    getSetting('smtp_pass'),
  ]);

  return c.json({
    host: host || process.env.SMTP_HOST || '',
    port: port || process.env.SMTP_PORT || '587',
    user: user || process.env.SMTP_USER || '',
    from: from || process.env.SMTP_FROM || '',
    hasPassword: !!pass || !!process.env.SMTP_PASS,
    source: host ? 'database' : process.env.SMTP_HOST ? 'environment' : 'none',
    configured: !!(host || process.env.SMTP_HOST),
  });
});

// PUT /api/settings/smtp — save SMTP config
settingsRoutes.put('/smtp', async (c) => {
  const body = await c.req.json<{
    host: string;
    port: string;
    user: string;
    pass?: string;
    from: string;
  }>();

  await Promise.all([
    setSetting('smtp_host', body.host),
    setSetting('smtp_port', body.port || '587'),
    setSetting('smtp_user', body.user),
    setSetting('smtp_from', body.from),
    ...(body.pass !== undefined && body.pass !== '' ? [setSetting('smtp_pass', body.pass)] : []),
  ]);

  return c.json({ ok: true });
});

// POST /api/settings/smtp/test — proxy to runner (needs nodemailer)
settingsRoutes.post('/smtp/test', async (c) => {
  const { proxyToRunner } = await import('../middleware/proxy.js');
  return proxyToRunner(c as any);
});
