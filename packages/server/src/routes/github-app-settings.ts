/**
 * GitHub's App manifest callback (sandbox-github-app-tokens), admin only:
 *
 *   GET /api/settings/github-app/callback   GitHub returns here with a code
 *
 * It stays REST because GitHub redirects the admin's browser here. That
 * redirect is a cross-site navigation, so the `SameSite=Strict` session cookie
 * is not sent: like the MCP OAuth callback, the route is public and the
 * single-use `state` (minted for an admin's session by `githubApp.startManifest`)
 * is the credential. Its admin must still be an admin. The rest of
 * the App's settings (status, accounts, starting the flow, disconnecting) are
 * the `githubApp` tRPC procedures (`trpc/ports/github-app.ts`), which also
 * describes the flow.
 */

import { user } from '@funny/shared/db/schema-sqlite';
import { parseStoredJson } from '@funny/shared/json-validation';
import { eq } from 'drizzle-orm';
import { Hono } from 'hono';

import { db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { normalizeUserRole } from '../lib/types.js';
import {
  saveGithubApp,
  type SettingsStore,
  type StoredGithubApp,
} from '../services/github-app/app-config.js';
import {
  defaultGithubAppDeps,
  manifestStateSchema,
  RETURN_PAGE,
  STATE_PREFIX,
  type GithubAppDeps,
} from '../trpc/ports/github-app.js';

/**
 * Who started the flow and where to send them back, when `state` is a flow
 * started less than ten minutes ago. The state is deleted either way (single use).
 */
async function consumeState(
  store: SettingsStore,
  state: string,
  now: number,
): Promise<{ userId: string; origin: string } | null> {
  const key = `${STATE_PREFIX}${state}`;
  const raw = await store.get(key);
  if (!raw) return null;
  await store.delete(key);
  const saved = parseStoredJson(manifestStateSchema, raw, 'github app manifest state');
  if (!saved.ok || saved.value.expiresAt < now) return null;
  return { userId: saved.value.userId, origin: saved.value.origin };
}

/** Production: the user's current role, read from Better Auth's `user` table. */
async function isAdminInDb(userId: string): Promise<boolean> {
  const [row] = await db.select({ role: user.role }).from(user).where(eq(user.id, userId));
  return normalizeUserRole(row?.role) === 'admin';
}

/** Exchange GitHub's one-time manifest code for the new App, or null on any failure. */
async function convertManifest(
  doFetch: typeof fetch,
  api: string,
  code: string,
): Promise<StoredGithubApp | null> {
  try {
    const res = await doFetch(`${api}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { accept: 'application/vnd.github+json', 'user-agent': 'funny' },
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status}`);
    const body = (await res.json()) as {
      id?: number;
      slug?: string;
      pem?: string;
      owner?: { login?: string };
    };
    if (!body.id || !body.slug || !body.pem || !body.owner?.login) return null;
    return {
      appId: String(body.id),
      slug: body.slug,
      owner: body.owner.login,
      privateKey: body.pem,
    };
  } catch (error) {
    log.error('GitHub App manifest conversion failed', {
      namespace: 'github-app',
      error: String(error),
    });
    return null;
  }
}

export function createGithubAppSettingsRoutes(
  deps: GithubAppDeps & { isAdmin?: (userId: string) => Promise<boolean> },
) {
  const doFetch = deps.fetch ?? fetch;
  const api = deps.api ?? 'https://api.github.com';
  const now = deps.now ?? Date.now;
  const isAdmin = deps.isAdmin ?? isAdminInDb;
  const routes = new Hono<ServerEnv>();

  routes.get('/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state || !/^[A-Za-z0-9_-]{16,64}$/.test(state)) {
      return c.json({ error: 'Invalid callback' }, 400);
    }
    const flow = await consumeState(deps.store, state, now());
    if (!flow) return c.json({ error: 'Unknown, used or expired state' }, 400);
    if (!(await isAdmin(flow.userId))) {
      audit({
        action: 'authz.cross_tenant_refused',
        actorId: flow.userId,
        detail:
          'GitHub App manifest callback — the flow was started by a user who is no longer an admin',
        meta: { path: new URL(c.req.url).pathname, method: c.req.method },
      });
      return c.json({ error: 'Forbidden: admin required' }, 403);
    }
    const origin = flow.origin;
    const back = (outcome: string) => c.redirect(`${origin}${RETURN_PAGE}?githubApp=${outcome}`);

    const app = await convertManifest(doFetch, api, code);
    if (!app) return back('error');
    const stored = await saveGithubApp(deps.store, app);
    if (stored.isErr()) return back('error');
    log.info('GitHub App connected', {
      namespace: 'github-app',
      appId: app.appId,
      slug: app.slug,
      owner: app.owner,
    });
    // Straight on to installing it: one trip to GitHub instead of two.
    return c.redirect(`https://github.com/apps/${encodeURIComponent(app.slug)}/installations/new`);
  });

  return routes;
}

export function githubAppSettingsRoutes() {
  return createGithubAppSettingsRoutes(defaultGithubAppDeps());
}
