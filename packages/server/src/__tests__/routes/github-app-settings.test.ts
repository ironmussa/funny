import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ApiPorts } from '@funny/api';
import { Hono } from 'hono';

// The stored App's key is encrypted with the keyring: keep it out of ~/.funny.
process.env.FUNNY_DATA_DIR = mkdtempSync(join(tmpdir(), 'funny-github-app-routes-'));

const { createGithubAppSettingsRoutes } = await import('../../routes/github-app-settings.js');
const { createGithubAppPort } = await import('../../trpc/ports/github-app.js');
const { mountTrpc } = await import('../../trpc/mount.js');
const { authzPort } = await import('../../trpc/ports/authz.js');

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const ORIGIN = 'https://funny.example.com';

function setup(
  opts: {
    env?: Record<string, string>;
    conversion?: () => Response;
    token?: string | null;
    github?: (path: string, auth: string | null) => Response | undefined;
  } = {},
) {
  const data = new Map<string, string>();
  const store = {
    get: async (k: string) => data.get(k) ?? null,
    set: async (k: string, v: string) => void data.set(k, v),
    delete: async (k: string) => void data.delete(k),
  };
  let clock = Date.parse('2026-11-10T12:00:00Z');
  const conversions: string[] = [];
  const deps = {
    store,
    env: opts.env ?? {},
    api: 'https://api.example',
    now: () => clock,
    githubToken: async () => opts.token ?? null,
    fetch: (async (url: string, init?: RequestInit) => {
      if (!url.includes('/app-manifests/')) {
        const auth = new Headers(init?.headers).get('authorization');
        return (
          opts.github?.(url.replace('https://api.example', ''), auth) ??
          new Response('{}', { status: 404 })
        );
      }
      conversions.push(url);
      return (
        opts.conversion?.() ??
        new Response(
          JSON.stringify({ id: 42, slug: 'funny-acme', pem: privateKey, owner: { login: 'acme' } }),
          { status: 201 },
        )
      );
    }) as unknown as typeof fetch,
  };
  const routes = createGithubAppSettingsRoutes(deps);
  const appFor = (userId: string, role: string) => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('userId' as never, userId as never);
      c.set('userRole' as never, role as never);
      await next();
    });
    app.route('/api/settings/github-app', routes as never);
    // Status, accounts, the manifest start and disconnect are tRPC procedures.
    mountTrpc(
      app as never,
      (c) =>
        ({
          githubApp: createGithubAppPort(deps, c.req.header('origin')),
          authz: authzPort,
        }) as unknown as ApiPorts,
    );
    return app;
  };
  return {
    data,
    conversions,
    admin: appFor('admin-1', 'admin'),
    appFor,
    advance: (ms: number) => (clock += ms),
  };
}

/** A `githubApp.<name>` query; answers `{ status, body }` with the procedure's data as body. */
const query = async (app: Hono, name: string) => {
  const res = await app.request(`http://server/api/trpc/githubApp.${name}`);
  const json = (await res.json()) as any;
  return { status: res.status, body: json.result?.data ?? json };
};
const mutate = async (app: Hono, name: string, input?: unknown) => {
  const res = await app.request(`http://server/api/trpc/githubApp.${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const json = (await res.json()) as any;
  return { status: res.status, body: json.result?.data ?? json };
};
const status = (app: Hono) => query(app, 'status');
const accounts = (app: Hono) => query(app, 'accounts');
const start = (app: Hono, body: unknown = { target: 'org', org: 'acme' }) =>
  mutate(app, 'startManifest', body);
const disconnect = (app: Hono) => mutate(app, 'disconnect');
const callback = (app: Hono, state: string, code = 'abc') =>
  app.request(`http://server/api/settings/github-app/callback?code=${code}&state=${state}`);

describe('GitHub App settings', () => {
  test('non-admins are refused everywhere', async () => {
    const { appFor } = setup();
    const user = appFor('u-1', 'user');
    expect((await status(user)).status).toBe(403);
    expect((await start(user)).status).toBe(403);
    expect((await callback(user, 'x'.repeat(32))).status).toBe(403);
    expect((await accounts(user)).status).toBe(403);
    expect((await disconnect(user)).status).toBe(403);
  });

  test('not connected', async () => {
    const { admin } = setup();
    expect((await status(admin)).body).toEqual({ configured: false, source: 'none' });
  });

  test('the manifest targets the organization, has the sandbox permissions, no webhook, and redirects back', async () => {
    const { admin } = setup();
    const { body } = await start(admin);
    expect(body.action).toBe(
      `https://github.com/organizations/acme/settings/apps/new?state=${body.state}`,
    );
    const manifest = JSON.parse(body.manifest);
    expect(manifest.redirect_url).toBe(`${ORIGIN}/api/settings/github-app/callback`);
    expect(manifest.setup_url).toBe(`${ORIGIN}/preferences/github-app?githubApp=installed`);
    expect(manifest.hook_attributes.active).toBe(false);
    expect(manifest.public).toBe(false);
    expect(manifest.default_permissions.contents).toBe('write');
    expect(manifest.default_permissions.administration).toBeUndefined();
  });

  test('the callback stores the App, sends the admin on to install it, and the status shows it', async () => {
    const { admin, data } = setup();
    const { state } = (await start(admin)).body;
    const res = await callback(admin, state);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      'https://github.com/apps/funny-acme/installations/new',
    );
    expect(JSON.stringify([...data.values()])).not.toContain('PRIVATE KEY');

    const connected = (await status(admin)).body;
    expect(connected).toMatchObject({
      configured: true,
      source: 'database',
      appId: '42',
      slug: 'funny-acme',
      owner: 'acme',
    });
    expect(JSON.stringify(connected)).not.toContain('PRIVATE KEY');

    await disconnect(admin);
    expect((await status(admin)).body).toMatchObject({ configured: false });
  });

  test('an unknown, reused, foreign or expired state stores nothing and calls GitHub never', async () => {
    const { admin, appFor, conversions, data, advance } = setup();
    expect((await callback(admin, 'u'.repeat(32))).status).toBe(400);

    const first = (await start(admin)).body.state;
    expect((await callback(admin, first)).status).toBe(302);
    expect((await callback(admin, first)).status).toBe(400);

    const foreign = (await start(admin)).body.state;
    expect((await callback(appFor('admin-2', 'admin'), foreign)).status).toBe(400);

    const late = (await start(admin)).body.state;
    advance(11 * 60 * 1000);
    expect((await callback(admin, late)).status).toBe(400);

    expect(conversions).toHaveLength(1);
    expect([...data.keys()].filter((k) => k.startsWith('github_app_manifest_state:'))).toEqual([]);
  });

  test('accounts: the personal account and the organizations the admin administers', async () => {
    const auths: (string | null)[] = [];
    const { admin } = setup({
      token: 'ghp_admin',
      github: (path, auth) => {
        auths.push(auth);
        if (path === '/user') return Response.json({ login: 'octo' });
        if (path.startsWith('/user/memberships/orgs')) {
          return Response.json([
            { role: 'admin', organization: { login: 'acme' } },
            { role: 'member', organization: { login: 'not-mine' } },
          ]);
        }
      },
    });
    expect((await accounts(admin)).body).toEqual({
      hasToken: true,
      accounts: [
        { login: 'octo', type: 'user' },
        { login: 'acme', type: 'org' },
      ],
    });
    expect(auths).toEqual(['Bearer ghp_admin', 'Bearer ghp_admin']);
  });

  test('accounts: a token without org access still offers the personal account', async () => {
    const { admin } = setup({
      token: 'ghp_admin',
      github: (path) =>
        path === '/user' ? Response.json({ login: 'octo' }) : new Response('{}', { status: 403 }),
    });
    expect((await accounts(admin)).body).toEqual({
      hasToken: true,
      accounts: [{ login: 'octo', type: 'user' }],
    });
  });

  test('accounts: no token or a refused token lists nothing', async () => {
    const none = setup();
    expect((await accounts(none.admin)).body).toEqual({ hasToken: false, accounts: [] });

    const refused = setup({ token: 'ghp_bad', github: () => new Response('{}', { status: 401 }) });
    expect((await accounts(refused.admin)).body).toEqual({ hasToken: true, accounts: [] });
  });

  test('configured through server variables: status says so and no new App can be started', async () => {
    const { admin } = setup({
      env: { GITHUB_APP_ID: '5690396', GITHUB_APP_PRIVATE_KEY: privateKey },
    });
    expect((await status(admin)).body).toMatchObject({
      configured: true,
      source: 'environment',
      appId: '5690396',
    });
    expect((await start(admin)).status).toBe(409);
  });

  test('a failed conversion sends the admin back with an error and stores nothing', async () => {
    const { admin, data } = setup({ conversion: () => new Response('{}', { status: 404 }) });
    const { state } = (await start(admin)).body;
    const res = await callback(admin, state);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/preferences/github-app?githubApp=error`);
    expect(data.has('github_app')).toBe(false);
  });
});
