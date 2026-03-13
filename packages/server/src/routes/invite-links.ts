/**
 * Invite link routes for the central server.
 *
 * Public routes (mounted before auth middleware):
 * - GET  /api/invite-links/verify/:token — validate a token
 * - POST /api/invite-links/register — register + join org via token
 *
 * Protected routes (mounted after auth middleware):
 * - POST   /api/invite-links — create an invite link
 * - GET    /api/invite-links — list invite links for the active org
 * - DELETE /api/invite-links/:id — revoke an invite link
 * - POST   /api/invite-links/accept — accept an invite link (existing user)
 */

import { randomBytes } from 'crypto';

import { eq, and } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';

import { db } from '../db/index.js';
import { inviteLinks } from '../db/schema.js';
import { auth } from '../lib/auth.js';
import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';

// ── Helpers ──────────────────────────────────────────────

function parseNum(val: string | null | undefined): number | null {
  if (val == null) return null;
  const n = parseInt(val, 10);
  return isNaN(n) ? null : n;
}

async function validateToken(token: string) {
  const [link] = await db
    .select()
    .from(inviteLinks)
    .where(and(eq(inviteLinks.token, token), eq(inviteLinks.revoked, '0')));

  if (!link) return { error: 'Invalid or expired invite link' as const, status: 404 as const };

  if (link.expiresAt && new Date(link.expiresAt) < new Date()) {
    return { error: 'This invite link has expired' as const, status: 410 as const };
  }

  const maxUses = parseNum(link.maxUses);
  const useCount = parseNum(link.useCount) ?? 0;
  if (maxUses !== null && useCount >= maxUses) {
    return {
      error: 'This invite link has reached its maximum uses' as const,
      status: 410 as const,
    };
  }

  return { link, useCount };
}

// Better Auth's organization plugin methods are not fully typed in the
// inferred API surface — cast to `any` for the invitation-related calls.
const orgApi = auth.api as any;

async function addUserToOrg(
  userId: string,
  email: string,
  orgId: string,
  role: string,
  headers: Headers,
) {
  // Use Better Auth's invitation flow: create invitation + accept it
  await orgApi.inviteMember({
    body: { email, role, organizationId: orgId },
    headers,
  });

  // Find and accept the pending invitation
  const pendingInvitations = await orgApi.listInvitations({
    headers,
    query: { organizationId: orgId },
  });

  const invitation = (pendingInvitations as any[])?.find(
    (inv: any) => inv.email === email && inv.organizationId === orgId && inv.status === 'pending',
  );

  if (invitation) {
    await orgApi.acceptInvitation({
      headers,
      body: { invitationId: invitation.id },
    });
  }

  // Set the user's active organization
  await orgApi.setActiveOrganization({
    headers,
    body: { organizationId: orgId },
  });
}

// ── Public routes (before auth middleware) ────────────────

export const inviteLinkPublicRoutes = new Hono();

// GET /verify/:token — validate a token and return org info
inviteLinkPublicRoutes.get('/verify/:token', async (c) => {
  const result = await validateToken(c.req.param('token'));
  if ('error' in result) return c.json({ error: result.error }, result.status);

  let organizationName = 'the team';
  try {
    const org = await orgApi.getFullOrganization({
      query: { organizationId: result.link.organizationId },
    });
    if (org) organizationName = org.name || organizationName;
  } catch {
    // Ignore — will use fallback name
  }

  return c.json({
    valid: true,
    role: result.link.role,
    organizationName,
    organizationId: result.link.organizationId,
  });
});

// POST /register — register a new user via invite token
inviteLinkPublicRoutes.post('/register', async (c) => {
  const body = await c.req.json<{
    token: string;
    username: string;
    password: string;
    displayName?: string;
  }>();

  if (!body.token || !body.username || !body.password) {
    return c.json({ error: 'Token, username, and password are required' }, 400);
  }

  const result = await validateToken(body.token);
  if ('error' in result) return c.json({ error: result.error }, result.status);

  const { link, useCount } = result;

  try {
    // 1. Create the user via admin API (bypasses disableSignUp)
    const email = `${body.username}@invite.local`;
    const createResult = await auth.api.createUser({
      body: {
        email,
        password: body.password,
        name: body.displayName || body.username,
        role: 'user',
        data: { username: body.username },
      },
    } as any);

    const user = (createResult as any)?.user;
    if (!user) {
      return c.json({ error: 'Failed to create account' }, 500);
    }

    // 2. Sign the user in — returns Set-Cookie headers
    const signInResponse = await orgApi.signInUsername({
      body: { username: body.username, password: body.password },
      headers: c.req.raw.headers,
      asResponse: true,
    });

    // 3. Add user to the org
    try {
      await addUserToOrg(
        user.id,
        user.email,
        link.organizationId,
        link.role,
        signInResponse.headers,
      );
    } catch (orgErr: any) {
      log.warn('Failed to add user to org during invite registration', {
        namespace: 'invite',
        error: orgErr?.message,
      });
    }

    // 4. Increment use count
    await db
      .update(inviteLinks)
      .set({ useCount: String(useCount + 1) })
      .where(eq(inviteLinks.id, link.id));

    log.info('User registered and joined via invite link', {
      namespace: 'invite',
      orgId: link.organizationId,
      userId: user.id,
      username: body.username,
    });

    // 5. Forward the sign-in response (contains session cookies)
    const responseHeaders = new Headers({ 'Content-Type': 'application/json' });
    const cookies =
      signInResponse.headers.getSetCookie?.() ??
      (signInResponse.headers as any).raw?.()?.['set-cookie'] ??
      [];
    for (const cookie of cookies) {
      responseHeaders.append('Set-Cookie', cookie);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        user: {
          id: user.id,
          username: body.username,
          displayName: body.displayName || body.username,
        },
        organizationId: link.organizationId,
      }),
      { status: 200, headers: responseHeaders },
    );
  } catch (err: any) {
    log.error('Failed to register via invite link', { namespace: 'invite', error: err?.message });
    if (err?.message?.includes('already') || err?.message?.includes('exist')) {
      return c.json({ error: 'Username already taken. Try signing in instead.' }, 409);
    }
    return c.json({ error: err?.message || 'Registration failed' }, 500);
  }
});

// ── Protected routes (after auth middleware) ─────────────

export const inviteLinkRoutes = new Hono<ServerEnv>();

// POST / — create an invite link for the active org
inviteLinkRoutes.post('/', async (c) => {
  const orgId = c.get('organizationId');
  if (!orgId) return c.json({ error: 'No active organization' }, 400);

  const userId = c.get('userId');
  const body = await c.req.json<{
    role?: string;
    expiresInDays?: number;
    maxUses?: number;
  }>();

  const role = body.role || 'member';
  const token = randomBytes(24).toString('base64url');
  const now = new Date().toISOString();
  const expiresAt = body.expiresInDays
    ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000).toISOString()
    : null;

  const link = {
    id: nanoid(),
    organizationId: orgId,
    token,
    role,
    createdBy: userId,
    expiresAt,
    maxUses: body.maxUses != null ? String(body.maxUses) : null,
    useCount: '0',
    revoked: '0',
    createdAt: now,
  };

  await db.insert(inviteLinks).values(link);

  log.info('Invite link created', { namespace: 'invite', orgId, role });

  return c.json({
    id: link.id,
    token: link.token,
    role: link.role,
    expiresAt: link.expiresAt,
    maxUses: parseNum(link.maxUses),
    useCount: 0,
    createdAt: link.createdAt,
  });
});

// GET / — list invite links for the active org
inviteLinkRoutes.get('/', async (c) => {
  const orgId = c.get('organizationId');
  if (!orgId) return c.json({ error: 'No active organization' }, 400);

  const links = await db
    .select()
    .from(inviteLinks)
    .where(and(eq(inviteLinks.organizationId, orgId), eq(inviteLinks.revoked, '0')));

  return c.json(
    links.map((l) => ({
      id: l.id,
      token: l.token,
      role: l.role,
      expiresAt: l.expiresAt,
      maxUses: parseNum(l.maxUses),
      useCount: parseNum(l.useCount) ?? 0,
      createdAt: l.createdAt,
    })),
  );
});

// DELETE /:id — revoke an invite link
inviteLinkRoutes.delete('/:id', async (c) => {
  const orgId = c.get('organizationId');
  if (!orgId) return c.json({ error: 'No active organization' }, 400);

  const linkId = c.req.param('id');
  await db
    .update(inviteLinks)
    .set({ revoked: '1' })
    .where(and(eq(inviteLinks.id, linkId), eq(inviteLinks.organizationId, orgId)));

  return c.json({ ok: true });
});

// POST /accept — accept an invite link (user is already authenticated)
inviteLinkRoutes.post('/accept', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ token: string }>();

  if (!body.token) return c.json({ error: 'Token is required' }, 400);

  const result = await validateToken(body.token);
  if ('error' in result) return c.json({ error: result.error }, result.status);

  const { link, useCount } = result;

  try {
    // Get user info
    const allUsers = await orgApi.listUsers({ query: { limit: 1000 } });
    const user = (allUsers as any)?.users?.find((u: any) => u.id === userId);
    if (!user) return c.json({ error: 'User not found' }, 404);

    await addUserToOrg(userId, user.email, link.organizationId, link.role, c.req.raw.headers);

    // Increment use count
    await db
      .update(inviteLinks)
      .set({ useCount: String(useCount + 1) })
      .where(eq(inviteLinks.id, link.id));

    log.info('Invite link accepted', {
      namespace: 'invite',
      orgId: link.organizationId,
      userId,
    });

    return c.json({ ok: true, organizationId: link.organizationId });
  } catch (err: any) {
    log.error('Failed to accept invite link', { namespace: 'invite', error: err?.message });
    if (err?.message?.includes('already') || err?.body?.message?.includes('already')) {
      return c.json({ ok: true, organizationId: link.organizationId, alreadyMember: true });
    }
    return c.json({ error: err?.message || 'Failed to join organization' }, 500);
  }
});
