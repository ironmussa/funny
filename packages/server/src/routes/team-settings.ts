/**
 * @domain subdomain: Team Management
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 * @domain depends: Auth, Crypto
 */

import { Hono } from 'hono';

import { encrypt, decrypt } from '../lib/crypto.js';
import { requirePermission } from '../middleware/auth.js';
import type { HonoEnv } from '../types/hono-env.js';

export const teamSettingsRoutes = new Hono<HonoEnv>();

// GET /api/team-settings — get settings for the active org
teamSettingsRoutes.get('/', async (c) => {
  const orgId = c.get('organizationId');
  if (!orgId) return c.json({ error: 'No active organization' }, 400);

  const { auth } = await import('../lib/auth.js');
  const org = await auth.api.getFullOrganization({
    headers: c.req.raw.headers,
    query: { organizationId: orgId },
  });

  if (!org) return c.json({ error: 'Organization not found' }, 404);

  return c.json({
    id: org.id,
    name: org.name,
    slug: org.slug,
    logo: org.logo,
    hasApiKey: !!(org as any).anthropicApiKey,
    defaultModel: (org as any).defaultModel ?? null,
    defaultMode: (org as any).defaultMode ?? null,
    defaultPermissionMode: (org as any).defaultPermissionMode ?? null,
  });
});

// PUT /api/team-settings/api-key — set encrypted API key
teamSettingsRoutes.put('/api-key', requirePermission('member', 'update'), async (c) => {
  const orgId = c.get('organizationId');
  if (!orgId) return c.json({ error: 'No active organization' }, 400);

  const body = await c.req.json<{ apiKey: string | null }>();

  const { auth } = await import('../lib/auth.js');
  const encryptedKey = body.apiKey ? encrypt(body.apiKey) : null;

  await auth.api.updateOrganization({
    headers: c.req.raw.headers,
    body: {
      organizationId: orgId,
      data: { anthropicApiKey: encryptedKey } as any,
    },
  });

  return c.json({ ok: true, hasApiKey: !!body.apiKey });
});

// PUT /api/team-settings/defaults — update org default settings
teamSettingsRoutes.put('/defaults', requirePermission('member', 'update'), async (c) => {
  const orgId = c.get('organizationId');
  if (!orgId) return c.json({ error: 'No active organization' }, 400);

  const body = await c.req.json<{
    defaultModel?: string | null;
    defaultMode?: string | null;
    defaultPermissionMode?: string | null;
  }>();

  const { auth } = await import('../lib/auth.js');
  await auth.api.updateOrganization({
    headers: c.req.raw.headers,
    body: {
      organizationId: orgId,
      data: body as any,
    },
  });

  return c.json({ ok: true });
});

/**
 * Get the decrypted API key for an organization (internal use only, not exposed as HTTP route).
 */
export function getOrgApiKey(orgApiKeyEncrypted: string | null | undefined): string | null {
  if (!orgApiKeyEncrypted) return null;
  return decrypt(orgApiKeyEncrypted);
}
