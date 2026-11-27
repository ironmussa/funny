import { afterAll, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ApiPorts } from '@funny/api';
import { Hono } from 'hono';

import type { ServerEnv, UserRole } from '../../lib/types.js';
import { fakeFetch } from '../helpers/builders-routes.js';

// The stored App's key is encrypted with the keyring: keep it out of ~/.funny.
const dataDir = mkdtempSync(join(tmpdir(), 'funny-github-app-routes-'));
process.env.FUNNY_DATA_DIR = dataDir;
afterAll(() => rmSync(dataDir, { recursive: true, force: true }));

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
  const admins = new Set(['admin-1', 'admin-2']);
  const deps = {
    store,
    isAdmin: async (userId: string) => admins.has(userId),
    env: opts.env ?? {},
    api: 'https://api.example',
    now: () => clock,
    githubToken: async () => opts.token ?? null,
    fetch: fakeFetch(async (url, init) => {
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
    }),
  };
  const routes = createGithubAppSettingsRoutes(deps);
  const appFor = (userId: string, role: UserRole) => {
    const app = new Hono<ServerEnv>();
    app.use('*', async (c, next) => {
      c.set('userId', userId);
      c.set('userRole', role);
      await next();
    });
    app.route('/api/settings/github-app', routes);
    // Status, accounts, the manifest start and disconnect are tRPC procedures.
    mountTrpc(app, (c) => {
      const ports = {
        githubApp: createGithubAppPort(deps, c.req.header('origin')),
        authz: authzPort,
      };
      // SAFETY: this suite only calls `githubApp.*` procedures, which reach no other port.
      return ports as ApiPorts;
    });
    return app;
  };
  // GitHub's redirect back is cross-site: the SameSite=Strict session cookie is
  // not sent, so the callback runs with no session at all.
  const anonymous = new Hono<ServerEnv>();
  anonymous.route('/api/settings/github-app', routes);
  return {
    data,
    conversions,
    admins,
    anonymous,
    admin: appFor('admin-1', 'admin'),
    appFor,
    advance: (ms: number) => (clock += ms),
  };
}

/** A `githubApp.<name>` query; answers `{ status, body }` with the procedure's data as body. */
const query = async (app: Hono<ServerEnv>, name: string) => {
  const res = await app.request(`http://server/api/trpc/githubApp.${name}`);
  const json = await res.json();
  return { status: res.status, body: json.result?.data ?? json };
};
const mutate = async (app: Hono<ServerEnv>, name: string, input?: unknown) => {
  const res = await app.request(`http://server/api/trpc/githubApp.${name}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
  const json = await res.json();
  return { status: res.status, body: json.result?.data ?? json };
};
const status = (app: Hono<ServerEnv>) => query(app, 'status');
const accounts = (app: Hono<ServerEnv>) => query(app, 'accounts');
const start = (app: Hono<ServerEnv>, body: unknown = { target: 'org', org: 'acme' }) =>
  mutate(app, 'startManifest', body);
const disconnect = (app: Hono<ServerEnv>) => mutate(app, 'disconnect');
const connectExisting = (app: Hono<ServerEnv>, body: unknown) =>
  mutate(app, 'connectExisting', body);
/** GitHub's `GET /app` for App 77, owned by the `goliiive` organization. */
const existingApp = (path: string, auth: string | null) =>
  path === '/app' && auth?.startsWith('Bearer ')
    ? new Response(
        JSON.stringify({ id: 77, slug: 'funny-localhost-1', owner: { login: 'goliiive' } }),
      )
    : undefined;
const callback = (app: Hono<ServerEnv>, state: string, code = 'abc') =>
  app.request(`http://server/api/settings/github-app/callback?code=${code}&state=${state}`);

describe('GitHub App settings', () => {
  test('non-admins are refused everywhere', async () => {
    const { appFor } = setup();
    const user = appFor('u-1', 'user');
    expect((await status(user)).status).toBe(403);
    expect((await start(user)).status).toBe(403);
    expect((await accounts(user)).status).toBe(403);
    expect((await disconnect(user)).status).toBe(403);
    expect((await connectExisting(user, { appId: '77', privateKey })).status).toBe(403);
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
    expect(manifest.hook_attributes).toBeUndefined();
    expect(manifest.public).toBe(false);
    expect(manifest.default_permissions.contents).toBe('write');
    expect(manifest.default_permissions.administration).toBeUndefined();
  });

  test('the callback stores the App, sends the admin on to install it, and the status shows it', async () => {
    const { admin, anonymous, data } = setup();
    const { state } = (await start(admin)).body;
    const res = await callback(anonymous, state);
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

  test('the status names the permissions the App lacks, read as the App', async () => {
    const sandboxSet = {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      workflows: 'write',
      actions: 'read',
      checks: 'read',
      statuses: 'read',
      metadata: 'read',
    };
    const auths: Array<string | null> = [];
    const statusWith = async (permissions: Record<string, string> | null) => {
      const { admin, anonymous } = setup({
        github: (path, auth) => {
          if (path !== '/app') return undefined;
          auths.push(auth);
          return permissions
            ? new Response(JSON.stringify({ permissions }), { status: 200 })
            : new Response('{}', { status: 500 });
        },
      });
      const { state } = (await start(admin)).body;
      await callback(anonymous, state);
      return (await status(admin)).body;
    };

    // An App created before the factory needed to publish its check and its review status.
    expect((await statusWith(sandboxSet)).missingPermissions).toEqual([
      'checks: write',
      'statuses: write',
    ]);
    // One created for the regression proof, before the review gate.
    expect((await statusWith({ ...sandboxSet, checks: 'write' })).missingPermissions).toEqual([
      'statuses: write',
    ]);
    expect(
      (await statusWith({ ...sandboxSet, checks: 'write', statuses: 'write' })).missingPermissions,
    ).toEqual([]);
    // GitHub could not be asked: the screen says nothing.
    expect((await statusWith(null)).missingPermissions).toBeUndefined();

    // The App has the permission, but one installation has not accepted it yet.
    const full = { ...sandboxSet, checks: 'write', statuses: 'write' };
    const { admin, anonymous } = setup({
      github: (path) => {
        if (path === '/app') return new Response(JSON.stringify({ permissions: full }));
        if (path !== '/app/installations?per_page=100') return undefined;
        return new Response(
          JSON.stringify([
            { account: { login: 'acme' }, permissions: sandboxSet },
            { account: { login: 'alice' }, permissions: full },
          ]),
        );
      },
    });
    await callback(anonymous, (await start(admin)).body.state);
    expect((await status(admin)).body).toMatchObject({
      missingPermissions: [],
      pendingInstallations: ['acme'],
    });
    // Asked as the App (its JWT), never with a user's token.
    expect(auths.every((auth) => auth?.startsWith('Bearer ey'))).toBe(true);
  });

  test('a malformed installation does not hide the other installations', async () => {
    const full = {
      contents: 'write',
      pull_requests: 'write',
      issues: 'write',
      workflows: 'write',
      actions: 'read',
      checks: 'write',
      statuses: 'write',
      metadata: 'read',
    };
    const { admin, anonymous } = setup({
      github: (path) => {
        if (path === '/app') return new Response(JSON.stringify({ permissions: full }));
        if (path !== '/app/installations?per_page=100') return undefined;
        return new Response(
          JSON.stringify([
            { account: { login: 42 }, permissions: { contents: 'read' } },
            { account: 'acme', permissions: { contents: 'read' } },
            { account: { login: 'bob' }, permissions: { contents: 'read' } },
            { account: { login: 'alice' }, permissions: full },
          ]),
        );
      },
    });
    await callback(anonymous, (await start(admin)).body.state);
    expect((await status(admin)).body).toMatchObject({
      missingPermissions: [],
      pendingInstallations: ['unknown account', 'unknown account', 'bob'],
    });
  });

  test('an unknown, reused or expired state, or a demoted admin, stores nothing and calls GitHub never', async () => {
    const { admin, admins, anonymous, conversions, data, advance } = setup();
    expect((await callback(anonymous, 'u'.repeat(32))).status).toBe(400);

    const first = (await start(admin)).body.state;
    expect((await callback(anonymous, first)).status).toBe(302);
    expect((await callback(anonymous, first)).status).toBe(400);

    const demoted = (await start(admin)).body.state;
    admins.delete('admin-1');
    expect((await callback(anonymous, demoted)).status).toBe(403);
    admins.add('admin-1');

    const late = (await start(admin)).body.state;
    advance(11 * 60 * 1000);
    expect((await callback(anonymous, late)).status).toBe(400);

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

  test('an existing App is checked with GitHub, stored with its key encrypted, and shown', async () => {
    const { admin, data } = setup({ github: existingApp });
    const res = await connectExisting(admin, { appId: '77', privateKey });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      configured: true,
      source: 'database',
      appId: '77',
      slug: 'funny-localhost-1',
      owner: 'goliiive',
      installUrl: 'https://github.com/apps/funny-localhost-1/installations/new',
    });
    expect(JSON.stringify(res.body)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify([...data.values()])).not.toContain('PRIVATE KEY');
    expect((await status(admin)).body).toMatchObject({ appId: '77', slug: 'funny-localhost-1' });
  });

  test('an existing App key pasted as one line with \\n escapes is accepted', async () => {
    const { admin } = setup({ github: existingApp });
    const oneLine = privateKey.trim().replace(/\n/g, '\\n');
    expect((await connectExisting(admin, { appId: '77', privateKey: oneLine })).status).toBe(200);
  });

  test('an existing App GitHub refuses, of another ID, or with a non-PEM key stores nothing', async () => {
    const refused = setup({ github: () => new Response('{}', { status: 401 }) });
    expect((await connectExisting(refused.admin, { appId: '77', privateKey })).status).toBe(400);
    expect(refused.data.size).toBe(0);

    const other = setup({ github: existingApp });
    expect((await connectExisting(other.admin, { appId: '78', privateKey })).status).toBe(400);
    expect(other.data.size).toBe(0);

    const notPem = setup({ github: existingApp });
    const res = await connectExisting(notPem.admin, { appId: '77', privateKey: 'not a key' });
    expect(res.status).toBe(400);
    expect(notPem.data.size).toBe(0);

    const badId = setup({ github: existingApp });
    expect((await connectExisting(badId.admin, { appId: 'abc', privateKey })).status).toBe(400);
  });

  test('an existing App cannot be checked while GitHub is down: 502, nothing stored', async () => {
    const { admin, data } = setup({ github: () => new Response('{}', { status: 503 }) });
    expect((await connectExisting(admin, { appId: '77', privateKey })).status).toBe(502);
    expect(data.size).toBe(0);
  });

  test('an existing App cannot replace one configured through server variables', async () => {
    const { admin, data } = setup({
      env: { GITHUB_APP_ID: '5690396', GITHUB_APP_PRIVATE_KEY: privateKey },
      github: existingApp,
    });
    expect((await connectExisting(admin, { appId: '77', privateKey })).status).toBe(409);
    expect(data.size).toBe(0);
  });
});
