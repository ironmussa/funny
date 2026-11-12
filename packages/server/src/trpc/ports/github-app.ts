/**
 * The deployment's GitHub App for sandbox threads (sandbox-github-app-tokens),
 * admin only, for the `githubApp` tRPC router. GitHub's manifest callback
 * stays REST (routes/github-app-settings.ts): GitHub redirects the admin's
 * browser there.
 *
 * The manifest flow creates the deployment's App on GitHub with one click: the
 * browser posts a pre-filled manifest to GitHub, GitHub sends the admin back
 * with a one-time code, and the server exchanges it for the App's ID and
 * private key, stored encrypted, then sends the admin straight on to install
 * it (GitHub returns them to `setup_url` afterwards). The `state` is
 * single-use, expires in ten minutes and belongs to the admin who started the
 * flow.
 *
 * Built per request: the flow returns the admin to the request's origin.
 */

import { randomBytes } from 'node:crypto';

import { failure, type GithubAppPort } from '@funny/api';
import type { GithubAppAccount } from '@funny/shared/contracts/github-app';
import { err, ok } from 'neverthrow';
import { z } from 'zod';

import { log } from '../../lib/logger.js';
import {
  deleteGithubApp,
  loadGithubAppConfig,
  sqlSettingsStore,
  type SettingsStore,
} from '../../services/github-app/app-config.js';
import { SANDBOX_PERMISSIONS } from '../../services/github-app/token-issuer.js';
import { getProviderKey } from '../../services/profile-service.js';

export interface GithubAppDeps {
  store: SettingsStore;
  env: Readonly<Record<string, string | undefined>>;
  fetch?: typeof fetch;
  api?: string;
  now?: () => number;
  /** The admin's own GitHub token (Settings > Profile), to list their accounts. */
  githubToken?: (userId: string) => Promise<string | null>;
}

export const defaultGithubAppDeps = (): GithubAppDeps => ({
  store: sqlSettingsStore,
  env: process.env,
});

const STATE_TTL_MS = 10 * 60 * 1000;
export const STATE_PREFIX = 'github_app_manifest_state:';
export const RETURN_PAGE = '/preferences/github-app';

export const manifestStateSchema = z.object({
  userId: z.string(),
  origin: z.string(),
  expiresAt: z.number(),
});

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
 * The admin's personal account plus the organizations they administer (only
 * an org admin can create an App there), read with their own token. Empty
 * when they have no token or GitHub refuses it: the form then asks for a name.
 */
async function listAccounts(
  doFetch: typeof fetch,
  api: string,
  token: string,
): Promise<GithubAppAccount[]> {
  const get = async (path: string) => {
    const res = await doFetch(`${api}${path}`, {
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'user-agent': 'funny',
      },
    });
    if (!res.ok) throw new Error(`GitHub answered ${res.status} for ${path}`);
    return res.json();
  };
  try {
    const user = (await get('/user')) as { login?: string };
    if (!user.login) return [];
    const accounts: GithubAppAccount[] = [{ login: user.login, type: 'user' }];
    // A classic token without read:org gets 403 here: still offer the personal account.
    const memberships = (await get('/user/memberships/orgs?state=active&per_page=100').catch(
      () => [],
    )) as { role?: string; organization?: { login?: string } }[];
    for (const m of memberships) {
      if (m.role === 'admin' && m.organization?.login) {
        accounts.push({ login: m.organization.login, type: 'org' });
      }
    }
    return accounts;
  } catch (error) {
    log.warn('Could not list GitHub accounts for the App setup', {
      namespace: 'github-app',
      error: String(error),
    });
    return [];
  }
}

export function createGithubAppPort(
  deps: GithubAppDeps,
  originHeader: string | undefined,
): GithubAppPort {
  const doFetch = deps.fetch ?? fetch;
  const api = deps.api ?? 'https://api.github.com';
  const now = deps.now ?? Date.now;
  const githubToken = deps.githubToken ?? ((userId) => getProviderKey(userId, 'github'));

  return {
    async status() {
      const config = await loadGithubAppConfig(deps.env, deps.store);
      if (config.isErr()) {
        return ok({ configured: false, source: 'environment' as const, error: config.error });
      }
      const app = config.value;
      if (!app) return ok({ configured: false, source: 'none' as const });
      return ok({
        configured: true,
        source: app.source,
        appId: app.appId,
        slug: app.slug,
        owner: app.owner,
        installUrl: app.slug ? `https://github.com/apps/${app.slug}/installations/new` : null,
        settingsUrl: app.slug ? `https://github.com/settings/apps/${app.slug}` : null,
      });
    },

    async accounts(userId) {
      const token = await githubToken(userId);
      const accounts = token ? await listAccounts(doFetch, api, token) : [];
      return ok({ accounts, hasToken: !!token });
    },

    async startManifest(userId, { target, org }) {
      const existing = await loadGithubAppConfig(deps.env, deps.store);
      if (existing.isOk() && existing.value?.source === 'environment') {
        return err(failure(409, 'The GitHub App is configured through server variables'));
      }
      const origin = originOf(originHeader);
      if (!origin) return err(failure(400, 'Missing or invalid Origin'));

      const state = randomBytes(24).toString('base64url');
      await deps.store.set(
        `${STATE_PREFIX}${state}`,
        JSON.stringify({ userId, origin, expiresAt: now() + STATE_TTL_MS }),
      );
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
        setup_url: `${origin}${RETURN_PAGE}?githubApp=installed`,
        public: false,
        default_permissions: SANDBOX_PERMISSIONS.write,
        default_events: [],
      };
      return ok({ action, manifest: JSON.stringify(manifest), state });
    },

    async disconnect() {
      const deleted = await deleteGithubApp(deps.store);
      return deleted.isErr() ? err(failure(500, deleted.error)) : ok({ ok: true as const });
    },
  };
}
