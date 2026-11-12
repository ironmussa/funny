/**
 * User settings (agent execution profiles and their per-project binding) and
 * the instance-level SMTP settings, for both `/api/settings` (REST) and the
 * `settings` tRPC router. Admin and project checks happen before these run
 * (`adminProcedure` / `projectProcedure`, or `requireAdmin` /
 * `requireProjectAccess` on REST).
 */

import { failure, type SettingsPort } from '@funny/api';
import { eq } from 'drizzle-orm';
import { err, ok } from 'neverthrow';

import { db } from '../../db/index.js';
import { instanceSettings } from '../../db/schema.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import * as agentProfileRepo from '../../services/agent-execution-profile-repository.js';

const profileNotFound = () => err(failure(404, 'Agent execution profile not found'));

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

/** The stored value, else the environment's, else `fallback`. */
const pick = (stored: string | null, env: string | undefined, fallback = '') =>
  stored || env || fallback;

/** The SMTP settings in effect: each field from the DB, else the environment. */
async function effectiveSmtp() {
  const [host, port, user, from, pass] = await Promise.all(
    ['smtp_host', 'smtp_port', 'smtp_user', 'smtp_from', 'smtp_pass'].map(getSetting),
  );
  const env = process.env;
  return {
    host: pick(host, env.SMTP_HOST),
    port: pick(port, env.SMTP_PORT, '587'),
    user: pick(user, env.SMTP_USER),
    from: pick(from, env.SMTP_FROM),
    /** The encrypted stored password (`null` when none), never sent to the client. */
    storedPass: pass,
    envPass: env.SMTP_PASS,
    source: host
      ? ('database' as const)
      : env.SMTP_HOST
        ? ('environment' as const)
        : ('none' as const),
  };
}

/** The stored password in clear; values saved before encryption was added are read as is. */
const clearPassword = (stored: string | null) => (stored ? (decrypt(stored) ?? stored) : '');

export const settingsPort: SettingsPort = {
  async listAgentProfiles(userId) {
    return ok({ profiles: await agentProfileRepo.listProfiles(userId) });
  },

  async createAgentProfile(userId, data) {
    return ok(await agentProfileRepo.createProfile(userId, data));
  },

  async updateAgentProfile(userId, id, data) {
    const profile = await agentProfileRepo.updateProfile(id, userId, data);
    return profile ? ok(profile) : profileNotFound();
  },

  async deleteAgentProfile(userId, id) {
    const deleted = await agentProfileRepo.deleteProfile(id, userId);
    return deleted ? ok({ ok: true as const }) : profileNotFound();
  },

  async getProjectBinding(userId, projectId) {
    return ok(await agentProfileRepo.getProjectBinding(projectId, userId));
  },

  async setProjectBinding(userId, projectId, profileId) {
    const binding = await agentProfileRepo.setProjectBinding(projectId, userId, profileId);
    return binding ? ok(binding) : profileNotFound();
  },

  // Never exposes the password.
  async getSmtp() {
    const { storedPass, envPass, ...smtp } = await effectiveSmtp();
    return ok({
      ...smtp,
      hasPassword: !!storedPass || !!envPass,
      configured: smtp.source !== 'none',
    });
  },

  async saveSmtp(data) {
    await Promise.all([
      setSetting('smtp_host', data.host),
      setSetting('smtp_port', data.port || '587'),
      setSetting('smtp_user', data.user),
      setSetting('smtp_from', data.from),
      ...(data.pass !== undefined && data.pass !== ''
        ? [setSetting('smtp_pass', encrypt(data.pass))]
        : []),
    ]);
    return ok({ ok: true as const });
  },

  // Sends a test email to the configured sender with the stored settings.
  async testSmtp() {
    const smtp = await effectiveSmtp();
    if (!smtp.host || !smtp.from) return err(failure(400, 'SMTP not configured'));
    const port = Number(smtp.port);
    try {
      const nodemailer = await import('nodemailer');
      const transport = nodemailer.createTransport({
        host: smtp.host,
        port,
        secure: port === 465,
        disableFileAccess: true,
        disableUrlAccess: true,
        auth: { user: smtp.user, pass: clearPassword(smtp.storedPass) || smtp.envPass || '' },
      });
      await transport.sendMail({
        from: smtp.from,
        to: smtp.from,
        subject: 'Funny SMTP Test',
        text: 'This is a test email from Funny to verify your SMTP settings are working correctly.',
        disableFileAccess: true,
        disableUrlAccess: true,
      });
      return ok({ ok: true as const, sentTo: smtp.from });
    } catch (e: unknown) {
      return err(failure(502, e instanceof Error ? e.message : String(e)));
    }
  },
};
