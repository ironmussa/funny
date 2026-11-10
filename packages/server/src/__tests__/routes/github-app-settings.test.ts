import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hono } from 'hono';

// The stored App's key is encrypted with the keyring: keep it out of ~/.funny.
process.env.FUNNY_DATA_DIR = mkdtempSync(join(tmpdir(), 'funny-github-app-routes-'));

const { createGithubAppSettingsRoutes } = await import('../../routes/github-app-settings.js');

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const ORIGIN = 'https://funny.example.com';

function setup(opts: { env?: Record<string, string>; conversion?: () => Response } = {}) {
  const data = new Map<string, string>();
  const store = {
    get: async (k: string) => data.get(k) ?? null,
    set: async (k: string, v: string) => void data.set(k, v),
    delete: async (k: string) => void data.delete(k),
  };
  let clock = Date.parse('2026-11-10T12:00:00Z');
  const conversions: string[] = [];
  const routes = createGithubAppSettingsRoutes({
    store,
    env: opts.env ?? {},
    api: 'https://api.example',
    now: () => clock,
    fetch: (async (url: string) => {
      conversions.push(url);
      return (
        opts.conversion?.() ??
        new Response(
          JSON.stringify({ id: 42, slug: 'funny-acme', pem: privateKey, owner: { login: 'acme' } }),
          { status: 201 },
        )
      );
    }) as unknown as typeof fetch,
  });
  const appFor = (userId: string, role: string) => {
    const app = new Hono();
    app.use('*', async (c, next) => {
      c.set('userId' as never, userId as never);
      c.set('userRole' as never, role as never);
      await next();
    });
    app.route('/api/settings/github-app', routes as never);
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

const start = (app: Hono, body: unknown = { target: 'org', org: 'acme' }) =>
  app.request('http://server/api/settings/github-app/manifest', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: ORIGIN },
    body: JSON.stringify(body),
  });
const callback = (app: Hono, state: string, code = 'abc') =>
  app.request(`http://server/api/settings/github-app/callback?code=${code}&state=${state}`);

describe('GitHub App settings', () => {
  test('non-admins are refused everywhere', async () => {
    const { appFor } = setup();
    const user = appFor('u-1', 'user');
    expect((await user.request('http://server/api/settings/github-app')).status).toBe(403);
    expect((await start(user)).status).toBe(403);
    expect((await callback(user, 'x'.repeat(32))).status).toBe(403);
    expect(
      (await user.request('http://server/api/settings/github-app', { method: 'DELETE' })).status,
    ).toBe(403);
  });

  test('not connected', async () => {
    const { admin } = setup();
    const res = await admin.request('http://server/api/settings/github-app');
    expect(await res.json()).toEqual({ configured: false, source: 'none' });
  });

  test('the manifest targets the organization, has the sandbox permissions, no webhook, and redirects back', async () => {
    const { admin } = setup();
    const body = (await (await start(admin)).json()) as any;
    expect(body.action).toBe(
      `https://github.com/organizations/acme/settings/apps/new?state=${body.state}`,
    );
    const manifest = JSON.parse(body.manifest);
    expect(manifest.redirect_url).toBe(`${ORIGIN}/api/settings/github-app/callback`);
    expect(manifest.hook_attributes.active).toBe(false);
    expect(manifest.public).toBe(false);
    expect(manifest.default_permissions.contents).toBe('write');
    expect(manifest.default_permissions.administration).toBeUndefined();
  });

  test('the callback stores the App, never returns the key, and the status shows it', async () => {
    const { admin, data } = setup();
    const { state } = (await (await start(admin)).json()) as any;
    const res = await callback(admin, state);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(
      `${ORIGIN}/preferences/github-app?githubApp=connected`,
    );
    expect(JSON.stringify([...data.values()])).not.toContain('PRIVATE KEY');

    const status = await (await admin.request('http://server/api/settings/github-app')).json();
    expect(status).toMatchObject({
      configured: true,
      source: 'database',
      appId: '42',
      slug: 'funny-acme',
      owner: 'acme',
    });
    expect(JSON.stringify(status)).not.toContain('PRIVATE KEY');

    await admin.request('http://server/api/settings/github-app', { method: 'DELETE' });
    expect(
      await (await admin.request('http://server/api/settings/github-app')).json(),
    ).toMatchObject({
      configured: false,
    });
  });

  test('an unknown, reused, foreign or expired state stores nothing and calls GitHub never', async () => {
    const { admin, appFor, conversions, data, advance } = setup();
    expect((await callback(admin, 'u'.repeat(32))).status).toBe(400);

    const first = ((await (await start(admin)).json()) as any).state;
    expect((await callback(admin, first)).status).toBe(302);
    expect((await callback(admin, first)).status).toBe(400);

    const foreign = ((await (await start(admin)).json()) as any).state;
    expect((await callback(appFor('admin-2', 'admin'), foreign)).status).toBe(400);

    const late = ((await (await start(admin)).json()) as any).state;
    advance(11 * 60 * 1000);
    expect((await callback(admin, late)).status).toBe(400);

    expect(conversions).toHaveLength(1);
    expect([...data.keys()].filter((k) => k.startsWith('github_app_manifest_state:'))).toEqual([]);
  });

  test('configured through server variables: status says so and no new App can be started', async () => {
    const { admin } = setup({
      env: { GITHUB_APP_ID: '5690396', GITHUB_APP_PRIVATE_KEY: privateKey },
    });
    expect(
      await (await admin.request('http://server/api/settings/github-app')).json(),
    ).toMatchObject({
      configured: true,
      source: 'environment',
      appId: '5690396',
    });
    expect((await start(admin)).status).toBe(409);
  });

  test('a failed conversion sends the admin back with an error and stores nothing', async () => {
    const { admin, data } = setup({ conversion: () => new Response('{}', { status: 404 }) });
    const { state } = (await (await start(admin)).json()) as any;
    const res = await callback(admin, state);
    expect(res.headers.get('location')).toBe(`${ORIGIN}/preferences/github-app?githubApp=error`);
    expect(data.has('github_app')).toBe(false);
  });
});
