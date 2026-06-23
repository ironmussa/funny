/**
 * Settings routes for the central server.
 *
 * SMTP is instance-level and requires admin role. Agent execution profiles are
 * user-scoped settings and use the authenticated user id.
 */

import {
  createAgentExecutionProfileSchema,
  updateAgentExecutionProfileSchema,
  updateProjectAgentProfileBindingSchema,
} from '@funny/shared';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db, dbGet } from '../db/index.js';
import { instanceSettings, projectMembers } from '../db/schema.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import type { ServerEnv } from '../lib/types.js';
import { requireAdmin } from '../middleware/auth.js';
import * as agentProfileRepo from '../services/agent-execution-profile-repository.js';
import * as projectRepo from '../services/project-repository.js';
import { parseJsonBody } from '../validation/request.js';

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

async function userCanAccessProject(projectId: string, userId: string): Promise<boolean> {
  const project = await projectRepo.getProject(projectId);
  if (!project) return false;
  if (project.userId === userId) return true;
  const member = await dbGet(
    db
      .select({ userId: projectMembers.userId })
      .from(projectMembers)
      .where(and(eq(projectMembers.projectId, projectId), eq(projectMembers.userId, userId))),
  );
  return !!member;
}

// ── Agent execution profiles ────────────────────────────────────

// GET /api/settings/agent-profiles — list current user's execution profiles
settingsRoutes.get('/agent-profiles', async (c) => {
  const userId = c.get('userId') as string;
  return c.json({ profiles: await agentProfileRepo.listProfiles(userId) });
});

// POST /api/settings/agent-profiles — create current user's execution profile
settingsRoutes.post('/agent-profiles', async (c) => {
  const userId = c.get('userId') as string;
  const parsed = await parseJsonBody(c, createAgentExecutionProfileSchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);

  const profile = await agentProfileRepo.createProfile(userId, parsed.value);
  return c.json(profile, 201);
});

// PATCH /api/settings/agent-profiles/:id — update current user's execution profile
settingsRoutes.patch('/agent-profiles/:id', async (c) => {
  const userId = c.get('userId') as string;
  const parsed = await parseJsonBody(c, updateAgentExecutionProfileSchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);

  const profile = await agentProfileRepo.updateProfile(c.req.param('id'), userId, parsed.value);
  if (!profile) return c.json({ error: 'Agent execution profile not found' }, 404);
  return c.json(profile);
});

// DELETE /api/settings/agent-profiles/:id — delete current user's execution profile
settingsRoutes.delete('/agent-profiles/:id', async (c) => {
  const userId = c.get('userId') as string;
  const deleted = await agentProfileRepo.deleteProfile(c.req.param('id'), userId);
  if (!deleted) return c.json({ error: 'Agent execution profile not found' }, 404);
  return c.json({ ok: true });
});

// GET /api/settings/agent-profiles/projects/:projectId — read current user's project binding
settingsRoutes.get('/agent-profiles/projects/:projectId', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.param('projectId');
  if (!(await userCanAccessProject(projectId, userId))) {
    return c.json({ error: 'Project not found' }, 404);
  }

  return c.json(await agentProfileRepo.getProjectBinding(projectId, userId));
});

// PUT /api/settings/agent-profiles/projects/:projectId — set/clear current user's binding
settingsRoutes.put('/agent-profiles/projects/:projectId', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.param('projectId');
  if (!(await userCanAccessProject(projectId, userId))) {
    return c.json({ error: 'Project not found' }, 404);
  }

  const parsed = await parseJsonBody(c, updateProjectAgentProfileBindingSchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);

  const binding = await agentProfileRepo.setProjectBinding(
    projectId,
    userId,
    parsed.value.profileId,
  );
  if (!binding) return c.json({ error: 'Agent execution profile not found' }, 404);
  return c.json(binding);
});

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
      disableFileAccess: true,
      disableUrlAccess: true,
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
      disableFileAccess: true,
      disableUrlAccess: true,
    });

    return c.json({ ok: true, sentTo: smtpFrom });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 502);
  }
});
