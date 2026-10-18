/**
 * Security H3 / M3 regressions for the proxy:
 *  - the unauthenticated MCP OAuth callback reaches ONLY the runner its
 *    server-signed state is bound to (minted when the proxy forwarded the
 *    owner's authenticated `/oauth/start`), never another tenant's runner, and
 *    an unbound/forged state reaches no runner at all;
 *  - the callback page is rendered by the server, never relayed from a runner;
 *  - any proxied runner response carrying an active type (HTML, JavaScript,
 *    SVG…) is neutralized, while JSON / media pass through.
 */

process.env.RUNNER_AUTH_SECRET = 'test-secret';

import { beforeEach, describe, expect, test } from 'bun:test';

import { Hono } from 'hono';

import type { ServerEnv } from '../../lib/types.js';
import { createProxyToRunner } from '../../middleware/proxy.js';
import { fakeRunnerAccess } from '../helpers/runner-access-fakes.js';
import { FakeRunnerPresencePort, FakeRunnerRequestPort } from '../helpers/runner-port-fakes.js';

const RUNNER_OF: Record<string, string> = { 'user-a': 'runner-a', 'user-b': 'runner-b' };

let port: FakeRunnerRequestPort;
let presence: FakeRunnerPresencePort;

function makeApp() {
  const app = new Hono<ServerEnv>();
  app.use('*', async (c, next) => {
    const user = c.req.header('x-test-user');
    if (user) c.set('userId', user);
    return next();
  });
  app.all(
    '/api/*',
    createProxyToRunner({
      runnerAccess: fakeRunnerAccess({
        runnerFor: (userId) => RUNNER_OF[userId] ?? null,
        owners: { 'runner-a': 'user-a', 'runner-b': 'user-b' },
      }),
      requests: port,
      presence,
    }),
  );
  return app;
}

/** Start an OAuth flow as `user` and return the state the server bound to it. */
async function startFlow(app: Hono<ServerEnv>, user: string): Promise<string> {
  port.response = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ authUrl: 'https://auth.test' }),
    bodyEncoding: 'utf8',
  };
  const res = await app.request('/api/mcp/oauth/start', {
    method: 'POST',
    headers: { 'x-test-user': user, 'content-type': 'application/json' },
    body: JSON.stringify({ serverName: 'linear', projectPath: '/repo' }),
  });
  expect(res.status).toBe(200);
  const sent = port.requests.at(-1)!;
  expect(sent.runnerId).toBe(RUNNER_OF[user]);
  const state = sent.request.headers?.['X-Funny-OAuth-State'];
  expect(typeof state).toBe('string');
  return state!;
}

function runnerReplies(contentType: string, body: string) {
  port.response = {
    status: 200,
    headers: { 'content-type': contentType },
    body,
    bodyEncoding: 'utf8',
  };
}

beforeEach(() => {
  port = new FakeRunnerRequestPort();
  presence = new FakeRunnerPresencePort();
  for (const [user, runner] of Object.entries(RUNNER_OF)) {
    port.available.add(runner);
    presence.owners.set(runner, user);
  }
});

describe('proxy — MCP OAuth callback routing (H3/M3)', () => {
  test("a state bound to user A reaches A's runner only, never user B's", async () => {
    const app = makeApp();
    const stateA = await startFlow(app, 'user-a');
    await startFlow(app, 'user-b');
    port.requests.length = 0;

    runnerReplies('application/json', JSON.stringify({ success: true, error: null }));
    const res = await app.request(
      `/api/mcp/oauth/callback?code=c1&state=${encodeURIComponent(stateA)}`,
    );

    expect(res.status).toBe(200);
    expect(port.requests.map((r) => r.runnerId)).toEqual(['runner-a']);
    expect(port.requests[0].request.path).toContain('code=c1');
    // The callback signs no identity.
    expect(port.requests[0].request.headers?.['X-Forwarded-User']).toBeUndefined();
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Authentication successful');
  });

  test('an unbound, forged or tampered state reaches no runner', async () => {
    const app = makeApp();
    const stateA = await startFlow(app, 'user-a');
    port.requests.length = 0;
    const [v, , sig] = stateA.split('.');
    const retarget = Buffer.from(
      JSON.stringify({ u: 'user-b', r: 'runner-b', e: Date.now() + 60_000, n: 'x' }),
    ).toString('base64url');

    for (const state of ['', 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8', `${v}.${retarget}.${sig}`]) {
      const res = await app.request(
        `/api/mcp/oauth/callback?code=c1&state=${encodeURIComponent(state)}`,
      );
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('Invalid or expired state');
    }
    expect(port.requests).toHaveLength(0);
  });

  test('the bound runner offline → 502, no fallback to another online runner', async () => {
    const app = makeApp();
    const stateA = await startFlow(app, 'user-a');
    port.requests.length = 0;
    presence.owners.delete('runner-a');
    port.available.delete('runner-a');

    const res = await app.request(
      `/api/mcp/oauth/callback?code=c1&state=${encodeURIComponent(stateA)}`,
    );
    expect(res.status).toBe(502);
    expect(port.requests).toHaveLength(0);
  });

  test('runner HTML is never relayed: the server renders its own escaped page', async () => {
    const app = makeApp();
    const stateA = await startFlow(app, 'user-a');
    runnerReplies('text/html', '<script src="/api/evil.js"></script>');
    const res = await app.request(
      `/api/mcp/oauth/callback?code=c1&state=${encodeURIComponent(stateA)}`,
    );
    const html = await res.text();
    expect(res.status).toBe(502);
    expect(html).not.toContain('/api/evil.js');
    expect(html).toContain('<script src="/api/mcp/oauth/callback.js"></script>');

    runnerReplies('application/json', JSON.stringify({ success: false, error: '<img onerror=x>' }));
    const escaped = await (
      await app.request(`/api/mcp/oauth/callback?code=c1&state=${encodeURIComponent(stateA)}`)
    ).text();
    expect(escaped).not.toContain('<img onerror=x>');
    expect(escaped).toContain('&lt;img onerror=x&gt;');
  });

  test('only the OAuth start request receives a bound state', async () => {
    const app = makeApp();
    runnerReplies('application/json', '{}');
    await app.request('/api/mcp/servers', { headers: { 'x-test-user': 'user-a' } });
    expect(port.requests.at(-1)!.request.headers?.['X-Funny-OAuth-State']).toBeUndefined();
  });
});

describe('proxy — runner response content-type neutralization (H3)', () => {
  async function fetchAs(contentType: string, body = 'x') {
    runnerReplies(contentType, body);
    return makeApp().request('/api/files/raw?path=%2Frepo%2Fa', {
      headers: { 'x-test-user': 'user-a' },
    });
  }

  for (const type of [
    'text/html; charset=utf-8',
    'application/javascript',
    'text/javascript',
    'application/xhtml+xml',
    'text/xml',
    'text/css',
  ]) {
    test(`${type} is served inert (text/plain, attachment, sandbox, nosniff)`, async () => {
      const res = await fetchAs(type, '<script>alert(1)</script>');
      expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(res.headers.get('content-disposition')).toBe('attachment');
      expect(res.headers.get('content-security-policy')).toBe('sandbox');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });
  }

  test('SVG keeps its type for <img> but is forced to download and sandboxed', async () => {
    const res = await fetchAs('image/svg+xml', '<svg onload="alert(1)"/>');
    expect(res.headers.get('content-type')).toBe('image/svg+xml');
    expect(res.headers.get('content-disposition')).toBe('attachment');
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
  });

  for (const type of [
    'application/json; charset=utf-8',
    'image/png',
    'video/mp4',
    'audio/mpeg',
    'application/pdf',
    'text/plain; charset=utf-8',
    'text/markdown; charset=utf-8',
    'application/problem+json',
  ]) {
    test(`${type} passes through unchanged (plus nosniff)`, async () => {
      const res = await fetchAs(type, '{}');
      expect(res.headers.get('content-type')).toBe(type);
      expect(res.headers.get('content-disposition')).toBeNull();
      expect(res.headers.get('content-security-policy')).toBeNull();
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    });
  }

  test('a runner cannot opt out by sending its own CSP or disposition', async () => {
    port.response = {
      status: 200,
      headers: {
        'content-type': 'text/html',
        'content-disposition': 'inline',
        'content-security-policy': "script-src 'unsafe-inline'",
      },
      body: '<script>alert(1)</script>',
      bodyEncoding: 'utf8',
    };
    const res = await makeApp().request('/api/files/raw?path=%2Frepo%2Fa', {
      headers: { 'x-test-user': 'user-a' },
    });
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe('attachment');
    expect(res.headers.get('content-security-policy')).toBe('sandbox');
  });
});
