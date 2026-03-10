/**
 * @domain subdomain: Shared Kernel
 * @domain subdomain-type: generic
 * @domain type: domain-service
 * @domain layer: domain
 */

import { eq } from 'drizzle-orm';
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import { db, dbGet, dbRun } from '../db/index.js';
import { schema } from '../db/index.js';
import { decrypt, encrypt } from './crypto.js';
import { log } from './logger.js';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  from: string;
}

// ── Instance settings helpers ────────────────────────────────────

async function getSetting(key: string): Promise<string | null> {
  const row = await dbGet<{ value: string }>(
    db
      .select({ value: schema.instanceSettings.value })
      .from(schema.instanceSettings)
      .where(eq(schema.instanceSettings.key, key)),
  );
  return row?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
  const now = new Date().toISOString();
  const existing = await getSetting(key);
  if (existing !== null) {
    await dbRun(
      db
        .update(schema.instanceSettings)
        .set({ value, updatedAt: now })
        .where(eq(schema.instanceSettings.key, key)),
    );
  } else {
    await dbRun(db.insert(schema.instanceSettings).values({ key, value, updatedAt: now }));
  }
}

// ── SMTP config resolution ───────────────────────────────────────

/**
 * Load SMTP config from instance_settings DB table.
 * Returns partial fields (some may be null if not set).
 */
export async function getStoredSmtpConfig(): Promise<{
  host: string;
  port: string;
  user: string;
  from: string;
  hasPassword: boolean;
}> {
  const [host, port, user, from, pass] = await Promise.all([
    getSetting('smtp_host'),
    getSetting('smtp_port'),
    getSetting('smtp_user'),
    getSetting('smtp_from'),
    getSetting('smtp_pass'),
  ]);
  return {
    host: host ?? '',
    port: port ?? '587',
    user: user ?? '',
    from: from ?? '',
    hasPassword: !!pass,
  };
}

/**
 * Save SMTP config to instance_settings.
 * Password is encrypted before storing.
 */
export async function saveSmtpConfig(config: {
  host: string;
  port: string;
  user: string;
  pass?: string;
  from: string;
}): Promise<void> {
  await Promise.all([
    setSetting('smtp_host', config.host),
    setSetting('smtp_port', config.port || '587'),
    setSetting('smtp_user', config.user),
    setSetting('smtp_from', config.from),
    ...(config.pass !== undefined && config.pass !== ''
      ? [setSetting('smtp_pass', encrypt(config.pass))]
      : []),
  ]);
}

/**
 * Resolve SMTP config from instance_settings DB or env vars.
 * Returns null if no SMTP is configured.
 */
export async function getSmtpConfig(): Promise<SmtpConfig | null> {
  // Priority 1: instance-level settings from DB
  const host = await getSetting('smtp_host');
  const user = await getSetting('smtp_user');
  const encPass = await getSetting('smtp_pass');

  if (host && user && encPass) {
    const pass = decrypt(encPass);
    if (!pass) {
      log.warn('Failed to decrypt instance SMTP password', { namespace: 'email' });
    } else {
      const port = await getSetting('smtp_port');
      const from = await getSetting('smtp_from');
      return {
        host,
        port: parseInt(port || '587', 10),
        user,
        pass,
        from: from || user,
      };
    }
  }

  // Priority 2: environment variables
  const envHost = process.env.SMTP_HOST;
  const envUser = process.env.SMTP_USER;
  const envPass = process.env.SMTP_PASS;

  if (envHost && envUser && envPass) {
    return {
      host: envHost,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      user: envUser,
      pass: envPass,
      from: process.env.SMTP_FROM || envUser,
    };
  }

  return null;
}

/** Check whether email sending is configured. */
export async function isEmailConfigured(): Promise<boolean> {
  return (await getSmtpConfig()) !== null;
}

/**
 * Determine the source of SMTP config: 'database', 'environment', or 'none'.
 */
export async function getSmtpSource(): Promise<'database' | 'environment' | 'none'> {
  const host = await getSetting('smtp_host');
  if (host) return 'database';
  if (process.env.SMTP_HOST) return 'environment';
  return 'none';
}

/** Create a nodemailer transporter from the resolved config. */
function createTransporter(config: SmtpConfig): Transporter {
  return nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465,
    auth: {
      user: config.user,
      pass: config.pass,
    },
  });
}

/**
 * Send an email. Returns true on success, false on failure.
 * Logs a warning (not error) when SMTP is not configured.
 */
export async function sendEmail(to: string, subject: string, html: string): Promise<boolean> {
  const config = await getSmtpConfig();
  if (!config) {
    log.warn('No SMTP configured — email not sent', { namespace: 'email', to, subject });
    return false;
  }

  try {
    const transporter = createTransporter(config);
    await transporter.sendMail({
      from: config.from,
      to,
      subject,
      html,
    });
    log.info('Email sent', { namespace: 'email', to, subject });
    return true;
  } catch (err) {
    log.error('Failed to send email', { namespace: 'email', to, subject, error: err });
    return false;
  }
}

/**
 * Send a test email to verify SMTP settings work.
 */
export async function sendTestEmail(to: string): Promise<boolean> {
  return sendEmail(
    to,
    'Funny — SMTP Test',
    `<p>This is a test email from <strong>Funny</strong>.</p>
     <p>If you received this, your SMTP settings are working correctly.</p>`,
  );
}
