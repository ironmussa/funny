/**
 * GitHub's App manifest callback (sandbox-github-app-tokens), admin only:
 *
 *   GET /api/settings/github-app/callback   GitHub returns here with a code
 *
 * It stays REST because GitHub redirects the admin's browser here. The rest of
 * the App's settings (status, accounts, starting the flow, disconnecting) are
 * the `githubApp` tRPC procedures (`trpc/ports/github-app.ts`), which also
 * describes the flow.
 */

import { parseStoredJson } from '@funny/shared/json-validation';
import { Hono } from 'hono';

import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { requireAdmin } from '../middleware/auth.js';
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
 * The origin to send the admin back to, when `state` is a flow this admin
 * started less than ten minutes ago. The state is deleted either way (single use).
 */
async function consumeState(
  store: SettingsStore,
  state: string,
  userId: string,
  now: number,
): Promise<string | null> {
  const key = `${STATE_PREFIX}${state}`;
  const raw = await store.get(key);
  if (!raw) return null;
  await store.delete(key);
  const saved = parseStoredJson(manifestStateSchema, raw, 'github app manifest state');
  if (!saved.ok || saved.value.userId !== userId || saved.value.expiresAt < now) return null;
  return saved.value.origin;
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

export function createGithubAppSettingsRoutes(deps: GithubAppDeps) {
  const doFetch = deps.fetch ?? fetch;
  const api = deps.api ?? 'https://api.github.com';
  const now = deps.now ?? Date.now;
  const routes = new Hono<ServerEnv>();
  routes.use('*', requireAdmin);

  routes.get('/callback', async (c) => {
    const code = c.req.query('code');
    const state = c.req.query('state');
    if (!code || !state || !/^[A-Za-z0-9_-]{16,64}$/.test(state)) {
      return c.json({ error: 'Invalid callback' }, 400);
    }
    const origin = await consumeState(deps.store, state, c.get('userId'), now());
    if (!origin) return c.json({ error: 'Unknown, used, expired or foreign state' }, 400);
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
