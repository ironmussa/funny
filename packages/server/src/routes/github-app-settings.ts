/**
 * GitHub App settings (sandbox-github-app-tokens), admin only.
 *
 *   GET    /api/settings/github-app            status (never the key)
 *   POST   /api/settings/github-app/manifest   start GitHub's App manifest flow
 *   GET    /api/settings/github-app/callback   GitHub returns here with a code
 *   DELETE /api/settings/github-app            forget the stored App
 *
 * The manifest flow creates the deployment's App on GitHub with one click: the
 * browser posts a pre-filled manifest to GitHub, GitHub sends the admin back
 * with a one-time code, and the server exchanges it for the App's ID and
 * private key, stored encrypted. The `state` is single-use, expires in ten
 * minutes and belongs to the admin who started the flow.
 */

import { randomBytes } from 'node:crypto';

import { parseStoredJson } from '@funny/shared/json-validation';
import { Hono } from 'hono';
import { z } from 'zod';

import { log } from '../lib/logger.js';
import type { ServerEnv } from '../lib/types.js';
import { requireAdmin } from '../middleware/auth.js';
import {
  deleteGithubApp,
  loadGithubAppConfig,
  saveGithubApp,
  sqlSettingsStore,
  type SettingsStore,
  type StoredGithubApp,
} from '../services/github-app/app-config.js';
import { SANDBOX_PERMISSIONS } from '../services/github-app/token-issuer.js';

export interface GithubAppSettingsDeps {
  store: SettingsStore;
  env: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  api?: string;
  now?: () => number;
}

const STATE_TTL_MS = 10 * 60 * 1000;
const STATE_PREFIX = 'github_app_manifest_state:';
const RETURN_PAGE = '/preferences/github-app';

const startSchema = z
  .object({
    /** A personal account (`user`) or an organization (`org`). */
    target: z.enum(['user', 'org']),
    org: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,39}$/)
      .optional(),
  })
  .strict()
  .refine((v) => v.target === 'user' || !!v.org, { message: 'org is required' });

const stateSchema = z.object({ userId: z.string(), origin: z.string(), expiresAt: z.number() });

/** The browser's origin, for the redirect back; only plain http(s) origins. */
function originOf(header: string | undefined): string | null {
  if (!header) return null;
  try {
    const url = new URL(header);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === header
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

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
  const saved = parseStoredJson(stateSchema, raw, 'github app manifest state');
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

export function createGithubAppSettingsRoutes(deps: GithubAppSettingsDeps) {
  const doFetch = deps.fetch ?? fetch;
  const api = deps.api ?? 'https://api.github.com';
  const now = deps.now ?? Date.now;
  const routes = new Hono<ServerEnv>();
  routes.use('*', requireAdmin);

  routes.get('/', async (c) => {
    const config = await loadGithubAppConfig(deps.env, deps.store);
    if (config.isErr()) {
      return c.json({ configured: false, source: 'environment', error: config.error });
    }
    const app = config.value;
    if (!app) return c.json({ configured: false, source: 'none' });
    return c.json({
      configured: true,
      source: app.source,
      appId: app.appId,
      slug: app.slug,
      owner: app.owner,
      installUrl: app.slug ? `https://github.com/apps/${app.slug}/installations/new` : null,
      settingsUrl: app.slug ? `https://github.com/settings/apps/${app.slug}` : null,
    });
  });

  routes.post('/manifest', async (c) => {
    const parsed = startSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'Invalid request' }, 400);
    const existing = await loadGithubAppConfig(deps.env, deps.store);
    if (existing.isOk() && existing.value?.source === 'environment') {
      return c.json({ error: 'The GitHub App is configured through server variables' }, 409);
    }
    const origin = originOf(c.req.header('origin'));
    if (!origin) return c.json({ error: 'Missing or invalid Origin' }, 400);

    const state = randomBytes(24).toString('base64url');
    await deps.store.set(
      `${STATE_PREFIX}${state}`,
      JSON.stringify({ userId: c.get('userId'), origin, expiresAt: now() + STATE_TTL_MS }),
    );
    const { target, org } = parsed.data;
    const action =
      target === 'org'
        ? `https://github.com/organizations/${org}/settings/apps/new?state=${state}`
        : `https://github.com/settings/apps/new?state=${state}`;
    const manifest = {
      name: `funny-${new URL(origin).hostname.split('.')[0]}`.slice(0, 34),
      url: origin,
      description:
        "Short-lived, single-repository tokens for funny sandbox threads (git and gh), so the owner's personal access token never enters a sandbox.",
      hook_attributes: { url: origin, active: false },
      redirect_url: `${origin}/api/settings/github-app/callback`,
      public: false,
      default_permissions: SANDBOX_PERMISSIONS.write,
      default_events: [],
    };
    return c.json({ action, manifest: JSON.stringify(manifest), state });
  });

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
    return back('connected');
  });

  routes.delete('/', async (c) => {
    const deleted = await deleteGithubApp(deps.store);
    if (deleted.isErr()) return c.json({ error: deleted.error }, 500);
    return c.json({ ok: true });
  });

  return routes;
}

export function githubAppSettingsRoutes() {
  return createGithubAppSettingsRoutes({ store: sqlSettingsStore, env: process.env });
}
