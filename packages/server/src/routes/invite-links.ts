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

import { eq, and, sql } from 'drizzle-orm';
import { Hono } from 'hono';
import { nanoid } from 'nanoid';

import { db } from '../db/index.js';
import { inviteLinks } from '../db/schema.js';
import { audit } from '../lib/audit.js';
import { auth } from '../lib/auth.js';
import { log } from '../lib/logger.js';
import { validatePasswordStrength } from '../lib/password-policy.js';
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

/**
 * Security H10: atomically reserve a use-count slot on the invite link.
 *
 * The previous implementation validated `useCount < maxUses` in a separate
 * SELECT, then later issued `UPDATE ... SET useCount = useCount + 1`. Two
 * concurrent registrations could both pass the SELECT and both increment,
 * letting `maxUses` be exceeded. We now increment inside a single conditional
 * UPDATE that also re-checks revocation / expiry / remaining capacity. Returns
 * `true` when the slot was reserved, `false` when a racing caller won it.
 */
async function reserveInviteSlot(linkId: string): Promise<boolean> {
  const now = new Date().toISOString();
  const reserved = await db
    .update(inviteLinks)
    .set({
      useCount: sql`CAST((CAST(${inviteLinks.useCount} AS INTEGER) + 1) AS TEXT)`,
    })
    .where(
      and(
        eq(inviteLinks.id, linkId),
        eq(inviteLinks.revoked, '0'),
        sql`(${inviteLinks.maxUses} IS NULL OR CAST(${inviteLinks.useCount} AS INTEGER) < CAST(${inviteLinks.maxUses} AS INTEGER))`,
        sql`(${inviteLinks.expiresAt} IS NULL OR ${inviteLinks.expiresAt} > ${now})`,
      ),
    )
    .returning({ id: inviteLinks.id });
  return reserved.length > 0;
}

/**
 * Best-effort release of a previously reserved slot. Called when the
 * downstream side effect (user creation, org join) fails after the slot was
 * reserved. A successful prior call to `reserveInviteSlot` guarantees
 * `useCount >= 1`, so an unconditional decrement is safe.
 */
async function releaseInviteSlot(linkId: string): Promise<void> {
  try {
    await db
      .update(inviteLinks)
      .set({
        useCount: sql`CAST((CAST(${inviteLinks.useCount} AS INTEGER) - 1) AS TEXT)`,
      })
      .where(eq(inviteLinks.id, linkId));
  } catch (err: any) {
    log.warn('Failed to release reserved invite slot', {
      namespace: 'invite',
      linkId,
      error: err?.message ?? String(err),
    });
  }
}

// Better Auth's organization plugin methods are not fully typed in the
// inferred API surface — cast to `any` for the invitation-related calls.
function orgApi() {
  return auth.api as any;
}

async function addUserToOrg(
  userId: string,
  email: string,
  orgId: string,
  role: string,
  headers: Headers,
) {
  // Use Better Auth's invitation flow: create invitation + accept it
  await orgApi().inviteMember({
    body: { email, role, organizationId: orgId },
    headers,
  });

  // Find and accept the pending invitation
  const pendingInvitations = await orgApi().listInvitations({
    headers,
    query: { organizationId: orgId },
  });

  const invitation = (pendingInvitations as any[])?.find(
    (inv: any) => inv.email === email && inv.organizationId === orgId && inv.status === 'pending',
  );

  if (invitation) {
    await orgApi().acceptInvitation({
      headers,
      body: { invitationId: invitation.id },
    });
  }

  // Set the user's active organization
  await orgApi().setActiveOrganization({
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
    const org = await orgApi().getFullOrganization({
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

  // Enforce shared password strength policy (Security M5).
  const strength = validatePasswordStrength(body.password);
  if (!strength.ok) {
    return c.json({ error: strength.reason }, 400);
  }

  const result = await validateToken(body.token);
  if ('error' in result) return c.json({ error: result.error }, result.status);

  const { link } = result;

  // Security H10: reserve the slot BEFORE creating the user. This is an
  // atomic conditional UPDATE so two concurrent callers cannot both pass
  // the pre-check and then each increment — the database enforces the
  // `max_uses` ceiling.
  const reserved = await reserveInviteSlot(link.id);
  if (!reserved) {
    log.info('Invite link exhausted at reservation time', {
      namespace: 'invite',
      linkId: link.id,
      orgId: link.organizationId,
    });
    return c.json({ error: 'This invite link has reached its maximum uses' }, 410);
  }

  // Tracks whether the reserved slot has been consumed by a real user record.
  // If creation throws before the user exists we release the slot; if it throws
  // afterwards (sign-in / org-join) the user is real and the slot stays used.
  let slotConsumed = false;

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
      await releaseInviteSlot(link.id);
      return c.json({ error: 'Failed to create account' }, 500);
    }
    slotConsumed = true;

    // 2. Sign the user in — returns Set-Cookie headers
    const signInResponse = await orgApi().signInUsername({
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

    // Slot was already reserved atomically before user creation (see H10).

    audit({
      action: 'user.create',
      actorId: null,
      detail: `User "${body.username}" registered via invite link`,
      meta: { orgId: link.organizationId, userId: user.id },
    });
    audit({
      action: 'invite.accept',
      actorId: user.id,
      detail: `Joined org via invite link`,
      meta: { orgId: link.organizationId },
    });

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
    if (!slotConsumed) await releaseInviteSlot(link.id);
    // Return generic error to prevent user enumeration
    return c.json({ error: 'Registration failed. The username may already be taken.' }, 400);
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

  audit({
    action: 'invite.create',
    actorId: userId,
    detail: `Created invite link for org`,
    meta: { orgId, role, expiresAt: link.expiresAt },
  });
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

  const userId = c.get('userId');
  const linkId = c.req.param('id');
  await db
    .update(inviteLinks)
    .set({ revoked: '1' })
    .where(and(eq(inviteLinks.id, linkId), eq(inviteLinks.organizationId, orgId)));

  audit({
    action: 'invite.revoke',
    actorId: userId,
    detail: `Revoked invite link`,
    meta: { linkId, orgId },
  });

  return c.json({ ok: true });
});

// POST /accept — accept an invite link (user is already authenticated)
inviteLinkRoutes.post('/accept', async (c) => {
  const userId = c.get('userId');
  const body = await c.req.json<{ token: string }>();

  if (!body.token) return c.json({ error: 'Token is required' }, 400);

  const result = await validateToken(body.token);
  if ('error' in result) return c.json({ error: result.error }, result.status);

  const { link } = result;

  // Security H10: reserve the slot atomically before adding the user to
  // the org so concurrent acceptances cannot exceed `max_uses`.
  const reserved = await reserveInviteSlot(link.id);
  if (!reserved) {
    log.info('Invite link exhausted at reservation time', {
      namespace: 'invite',
      linkId: link.id,
      orgId: link.organizationId,
      userId,
    });
    return c.json({ error: 'This invite link has reached its maximum uses' }, 410);
  }

  try {
    // Get user info
    const allUsers = await orgApi().listUsers({ query: { limit: 1000 } });
    const user = (allUsers as any)?.users?.find((u: any) => u.id === userId);
    if (!user) {
      await releaseInviteSlot(link.id);
      return c.json({ error: 'User not found' }, 404);
    }

    await addUserToOrg(userId, user.email, link.organizationId, link.role, c.req.raw.headers);

    // Slot was already reserved atomically above (see H10).

    log.info('Invite link accepted', {
      namespace: 'invite',
      orgId: link.organizationId,
      userId,
    });

    return c.json({ ok: true, organizationId: link.organizationId });
  } catch (err: any) {
    log.error('Failed to accept invite link', { namespace: 'invite', error: err?.message });
    // Release the slot — the user did not actually join (either the join
    // threw, or they were already a member and the reservation was a no-op).
    await releaseInviteSlot(link.id);
    if (err?.message?.includes('already') || err?.body?.message?.includes('already')) {
      return c.json({ ok: true, organizationId: link.organizationId, alreadyMember: true });
    }
    return c.json({ error: err?.message || 'Failed to join organization' }, 500);
  }
});
