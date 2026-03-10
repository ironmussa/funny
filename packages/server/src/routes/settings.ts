/**
 * @domain subdomain: Shared Kernel
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: Email
 *
 * Instance-level settings (SMTP, etc.) — not per-org/team.
 */

import { Hono } from 'hono';

import {
  getStoredSmtpConfig,
  saveSmtpConfig,
  isEmailConfigured,
  getSmtpSource,
  sendTestEmail,
} from '../lib/email.js';
import type { HonoEnv } from '../types/hono-env.js';

export const settingsRoutes = new Hono<HonoEnv>();

// GET /api/settings/smtp — get SMTP settings (never exposes password)
settingsRoutes.get('/smtp', async (c) => {
  const stored = await getStoredSmtpConfig();
  const source = await getSmtpSource();
  const configured = await isEmailConfigured();

  return c.json({
    host: stored.host || process.env.SMTP_HOST || '',
    port: stored.port || process.env.SMTP_PORT || '587',
    user: stored.user || process.env.SMTP_USER || '',
    from: stored.from || process.env.SMTP_FROM || '',
    hasPassword: stored.hasPassword || !!process.env.SMTP_PASS,
    source,
    configured,
  });
});

// PUT /api/settings/smtp — save SMTP config (encrypts password)
settingsRoutes.put('/smtp', async (c) => {
  const body = await c.req.json<{
    host: string;
    port: string;
    user: string;
    pass?: string;
    from: string;
  }>();

  await saveSmtpConfig(body);
  return c.json({ ok: true });
});

// POST /api/settings/smtp/test — send a test email
settingsRoutes.post('/smtp/test', async (c) => {
  const user = c.get('user');
  const email = user?.email;
  if (!email) {
    return c.json({ error: 'No email on current user' }, 400);
  }

  const sent = await sendTestEmail(email);
  if (!sent) {
    return c.json({ error: 'Failed to send test email. Check your SMTP settings.' }, 500);
  }

  return c.json({ ok: true, sentTo: email });
});
