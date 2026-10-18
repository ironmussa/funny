/**
 * Security H1 + H7 regressions — runtime auth middleware.
 *
 * H1: proxied requests verify with THIS runner's per-runner key K_r. A request
 * signed with another runner's key, or with the deployment root secret, is
 * refused; no key configured ⇒ fail closed.
 *
 * H7: a direct-HTTP session cookie is accepted ONLY for the runner's owner.
 * Another valid server user is refused (403), and cookie auth fails closed
 * (without even calling the server) while the owner is unknown.
 */
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  process.env.TEAM_SERVER_URL = 'http://server.test';
  process.env.WS_TUNNEL_ONLY = 'false';
  const cryptoMod = require('crypto') as typeof import('crypto');
  if (typeof (globalThis as any).Bun === 'undefined') {
    (globalThis as any).Bun = {
      CryptoHasher: class {
        private hasher: ReturnType<typeof cryptoMod.createHash>;
        constructor(algo: string) {
          this.hasher = cryptoMod.createHash(algo);
        }
        update(data: string | Buffer) {
          this.hasher.update(data);
          return this;
        }
        digest(encoding: 'hex') {
          return this.hasher.digest(encoding);
        }
      },
    };
  }
});

vi.mock('../../lib/auth.js', () => ({
  auth: { api: { getSession: vi.fn().mockResolvedValue(null) } },
}));

import {
  NONCE_HEADER,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
  signForwardedIdentity,
} from '@funny/shared/auth/forwarded-identity';
import { deriveRunnerForwardingKey } from '@funny/shared/auth/runner-keys';

import { clearRunnerKeys, configureRunnerKeys } from '../../lib/runner-keys.js';
import { authMiddleware } from '../../middleware/auth.js';
import type { HonoEnv } from '../../types/hono-env.js';

const ROOT = 'root-secret-0123456789abcdef0123456789abcdef';
const OWNER = 'owner-user';

function buildApp(): Hono<HonoEnv> {
  const app = new Hono<HonoEnv>();
  app.use('*', authMiddleware);
  app.get('/api/resource', (c) => c.json({ userId: c.get('userId') }));
  app.post('/api/resource', (c) => c.json({ userId: c.get('userId') }));
  return app;
}

function signedHeaders(key: string, userId: string): Record<string, string> {
  const identity = { userId, role: 'user', orgId: null, orgName: null };
  const { signature, timestamp, nonce } = signForwardedIdentity(identity, key);
  return {
    'X-Runner-Auth': key,
    'X-Forwarded-User': userId,
    'X-Forwarded-Role': 'user',
    [SIGNATURE_HEADER]: signature,
    [TIMESTAMP_HEADER]: String(timestamp),
    [NONCE_HEADER]: nonce,
  };
}

function sessionResponse(userId: string): Response {
  return new Response(
    JSON.stringify({ user: { id: userId, role: 'user' }, session: { activeOrganizationId: null } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  clearRunnerKeys();
  fetchSpy = vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
  clearRunnerKeys();
});

describe('forwarded identity uses the per-runner key (security H1)', () => {
  test("accepts a request signed with this runner's key", async () => {
    configureRunnerKeys({ runnerId: 'runner-a', rootSecret: ROOT, ownerUserId: OWNER });
    const key = deriveRunnerForwardingKey(ROOT, 'runner-a');
    const res = await buildApp().request('/api/resource', { headers: signedHeaders(key, OWNER) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: OWNER });
  });

  test("rejects a request signed with ANOTHER runner's key", async () => {
    configureRunnerKeys({
      runnerId: 'runner-a',
      forwardingKey: deriveRunnerForwardingKey(ROOT, 'runner-a'),
    });
    const otherKey = deriveRunnerForwardingKey(ROOT, 'runner-b');
    const res = await buildApp().request('/api/resource', {
      headers: signedHeaders(otherKey, 'admin'),
    });
    expect(res.status).toBe(401);
  });

  test('rejects a request signed with the root secret itself', async () => {
    configureRunnerKeys({ runnerId: 'runner-a', rootSecret: ROOT });
    const res = await buildApp().request('/api/resource', {
      headers: signedHeaders(ROOT, 'admin'),
    });
    expect(res.status).toBe(401);
  });

  test('fails closed when the runner has no key yet', async () => {
    const key = deriveRunnerForwardingKey(ROOT, 'runner-a');
    const res = await buildApp().request('/api/resource', { headers: signedHeaders(key, OWNER) });
    expect(res.status).toBe(401);
  });
});

describe('session-cookie auth is owner-only (security H7)', () => {
  const COOKIE = 'better-auth.session_token=xyz';

  test("accepts the runner owner's session", async () => {
    configureRunnerKeys({ runnerId: 'runner-a', rootSecret: ROOT, ownerUserId: OWNER });
    fetchSpy.mockResolvedValue(sessionResponse(OWNER));
    const res = await buildApp().request('/api/resource', {
      method: 'POST',
      headers: { Cookie: COOKIE },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: OWNER });
  });

  test('rejects a valid session belonging to a different server user', async () => {
    configureRunnerKeys({ runnerId: 'runner-a', rootSecret: ROOT, ownerUserId: OWNER });
    fetchSpy.mockResolvedValue(sessionResponse('someone-else'));
    const app = buildApp();
    const res = await app.request('/api/resource', {
      method: 'POST',
      headers: { Cookie: `${COOKIE}-other` },
    });
    expect(res.status).toBe(403);

    // The cached entry for that cookie must not let a later GET through either.
    fetchSpy.mockClear();
    const cached = await app.request('/api/resource', { headers: { Cookie: `${COOKIE}-other` } });
    expect(cached.status).toBe(403);
  });

  test('fails closed (without calling the server) while the owner is unknown', async () => {
    configureRunnerKeys({ runnerId: 'runner-a', rootSecret: ROOT });
    fetchSpy.mockResolvedValue(sessionResponse(OWNER));
    const res = await buildApp().request('/api/resource', {
      method: 'POST',
      headers: { Cookie: `${COOKIE}-unknown` },
    });
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
