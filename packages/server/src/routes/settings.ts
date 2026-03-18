/**
 * Instance settings routes for the central server.
 *
 * Handles SMTP and other instance-level settings using the server's DB.
 * All routes require admin role.
 */

import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/index.js';
import { instanceSettings } from '../db/schema.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import type { ServerEnv } from '../lib/types.js';
import { requireAdmin } from '../middleware/auth.js';

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
settingsRoutes.get('/smtp', requireAdmin, async (c) => {
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
settingsRoutes.put('/smtp', requireAdmin, async (c) => {
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
    ...(body.pass !== undefined && body.pass !== ''
      ? [setSetting('smtp_pass', encrypt(body.pass))]
      : []),
  ]);

  return c.json({ ok: true });
});

// POST /api/settings/smtp/test — send a test email using stored SMTP settings
settingsRoutes.post('/smtp/test', requireAdmin, async (c) => {
  const [host, port, user, from, pass] = await Promise.all([
    getSetting('smtp_host'),
    getSetting('smtp_port'),
    getSetting('smtp_user'),
    getSetting('smtp_from'),
    getSetting('smtp_pass'),
  ]);

  const smtpHost = host || process.env.SMTP_HOST;
  const smtpFrom = from || process.env.SMTP_FROM;
  if (!smtpHost || !smtpFrom) {
    return c.json({ error: 'SMTP not configured' }, 400);
  }

  // Decrypt stored password; fall back to raw value for backwards compatibility
  // with passwords saved before encryption was added.
  const decryptedPass = pass ? (decrypt(pass) ?? pass) : '';

  try {
    const nodemailer = await import('nodemailer');
    const transport = nodemailer.createTransport({
      host: smtpHost,
      port: Number(port || process.env.SMTP_PORT || '587'),
      secure: Number(port || process.env.SMTP_PORT || '587') === 465,
      auth: {
        user: user || process.env.SMTP_USER || '',
        pass: decryptedPass || process.env.SMTP_PASS || '',
      },
    });

    await transport.sendMail({
      from: smtpFrom,
      to: smtpFrom,
      subject: 'Funny SMTP Test',
      text: 'This is a test email from Funny to verify your SMTP settings are working correctly.',
    });

    return c.json({ ok: true, sentTo: smtpFrom });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 502);
  }
});
