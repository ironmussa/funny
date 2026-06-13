import { Hono } from 'hono';
import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';

import { fetchRepoIssues } from '../../routes/github/helpers.js';
import { prRoutes } from '../../routes/github/prs.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { validate, cloneRepoSchema, githubPollSchema } from '../../validation/schemas.js';

/**
 * Tests for GitHub route logic.
 *
 * Since the routes depend on external GitHub API calls and profile-service,
 * we test the validation schemas and the parseGithubOwnerRepo utility inline,
 * plus route plumbing with a lightweight Hono app.
 */

// ── parseGithubOwnerRepo (extracted logic) ──────────────────────

function parseGithubOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  return null;
}

describe('GitHub Routes', () => {
  describe('parseGithubOwnerRepo', () => {
    test('parses HTTPS URL with .git suffix', () => {
      const result = parseGithubOwnerRepo('https://github.com/owner/repo.git');
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    test('parses HTTPS URL without .git suffix', () => {
      const result = parseGithubOwnerRepo('https://github.com/owner/my-repo');
      expect(result).toEqual({ owner: 'owner', repo: 'my-repo' });
    });

    test('parses SSH URL', () => {
      const result = parseGithubOwnerRepo('git@github.com:owner/repo.git');
      expect(result).toEqual({ owner: 'owner', repo: 'repo' });
    });

    test('parses SSH URL without .git suffix', () => {
      const result = parseGithubOwnerRepo('git@github.com:owner/my-repo');
      expect(result).toEqual({ owner: 'owner', repo: 'my-repo' });
    });

    test('returns null for non-GitHub URL', () => {
      expect(parseGithubOwnerRepo('https://gitlab.com/owner/repo.git')).toBeNull();
    });

    test('returns null for empty string', () => {
      expect(parseGithubOwnerRepo('')).toBeNull();
    });

    test('handles repos with hyphens', () => {
      const result = parseGithubOwnerRepo('https://github.com/my-org/my-repo-name.git');
      expect(result).toEqual({ owner: 'my-org', repo: 'my-repo-name' });
    });
  });

  describe('fetchRepoIssues', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    function stubFetch(impl: (url: string) => { ok: boolean; body: unknown }) {
      const calls: string[] = [];
      vi.stubGlobal('fetch', async (url: string) => {
        calls.push(url);
        const { ok, body } = impl(url);
        return {
          ok,
          headers: { get: () => null },
          json: async () => body,
          text: async () => JSON.stringify(body),
        } as unknown as Response;
      });
      return calls;
    }

    test('queries the Search API with type:issue so PRs cannot crowd out issues', async () => {
      // Regression: the old `/repos/:owner/:repo/issues` endpoint mixed PRs and
      // issues. On a repo with many recent PRs, a full page could be all PRs and
      // the client-side filter left zero issues even though closed issues exist.
      const calls = stubFetch(() => ({
        ok: true,
        body: {
          total_count: 352,
          items: [
            { number: 1080, title: 'Bug A', state: 'closed', pull_request: undefined },
            { number: 1079, title: 'Bug B', state: 'closed' },
          ],
        },
      }));

      const result = await fetchRepoIssues('goliiive', 'backend-v2', {
        state: 'closed',
        page: 1,
        perPage: 30,
        token: 'fake-token',
      });

      expect(calls).toHaveLength(1);
      const url = calls[0];
      expect(url).toContain('/search/issues');
      // `repo:goliiive/backend-v2 type:issue state:closed` (URL-encoded)
      expect(decodeURIComponent(url)).toContain('repo:goliiive/backend-v2 type:issue state:closed');
      expect(result?.issues.map((i) => i.number)).toEqual([1080, 1079]);
    });

    test('computes hasMore from total_count', async () => {
      stubFetch(() => ({
        ok: true,
        body: {
          total_count: 352,
          items: [{ number: 1, title: 'x', state: 'closed' }],
        },
      }));

      const page1 = await fetchRepoIssues('o', 'r', {
        state: 'closed',
        page: 1,
        perPage: 30,
        token: 't',
      });
      expect(page1?.hasMore).toBe(true); // 1 * 30 < 352

      const lastPage = await fetchRepoIssues('o', 'r', {
        state: 'closed',
        page: 12,
        perPage: 30,
        token: 't',
      });
      expect(lastPage?.hasMore).toBe(false); // 12 * 30 = 360 >= 352
    });

    test('defensively filters any PR that slips into the result set', async () => {
      stubFetch(() => ({
        ok: true,
        body: {
          total_count: 2,
          items: [
            { number: 5, title: 'real issue', state: 'open' },
            { number: 6, title: 'sneaky pr', state: 'open', pull_request: { url: 'x' } },
          ],
        },
      }));

      const result = await fetchRepoIssues('o', 'r', {
        state: 'open',
        page: 1,
        perPage: 30,
        token: 't',
      });
      expect(result?.issues.map((i) => i.number)).toEqual([5]);
    });

    test('returns null when the GitHub request fails', async () => {
      stubFetch(() => ({ ok: false, body: {} }));
      const result = await fetchRepoIssues('o', 'r', {
        state: 'open',
        page: 1,
        perPage: 30,
        token: 't',
      });
      expect(result).toBeNull();
    });
  });

  describe('cloneRepoSchema validation', () => {
    test('accepts valid clone request', () => {
      const result = validate(cloneRepoSchema, {
        cloneUrl: 'https://github.com/user/repo.git',
        destinationPath: '/tmp/clones',
      });
      expect(result.isOk()).toBe(true);
    });

    test('accepts clone request with optional name', () => {
      const result = validate(cloneRepoSchema, {
        cloneUrl: 'https://github.com/user/repo.git',
        destinationPath: '/tmp/clones',
        name: 'my-project',
      });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.name).toBe('my-project');
      }
    });

    test('rejects invalid clone URL', () => {
      const result = validate(cloneRepoSchema, {
        cloneUrl: 'not-a-url',
        destinationPath: '/tmp/clones',
      });
      expect(result.isErr()).toBe(true);
    });

    test('rejects empty destination path', () => {
      const result = validate(cloneRepoSchema, {
        cloneUrl: 'https://github.com/user/repo.git',
        destinationPath: '',
      });
      expect(result.isErr()).toBe(true);
    });

    test('rejects missing cloneUrl', () => {
      const result = validate(cloneRepoSchema, {
        destinationPath: '/tmp/clones',
      });
      expect(result.isErr()).toBe(true);
    });
  });

  describe('githubPollSchema validation', () => {
    test('accepts valid device code', () => {
      const result = validate(githubPollSchema, {
        deviceCode: 'abc-123-xyz',
      });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.deviceCode).toBe('abc-123-xyz');
      }
    });

    test('rejects empty device code', () => {
      const result = validate(githubPollSchema, {
        deviceCode: '',
      });
      expect(result.isErr()).toBe(true);
    });

    test('rejects missing device code', () => {
      const result = validate(githubPollSchema, {});
      expect(result.isErr()).toBe(true);
    });
  });

  describe('route plumbing', () => {
    let app: Hono;

    beforeEach(() => {
      app = new Hono();

      // Minimal /status route that mimics the real one
      app.get('/status', (c) => {
        // Simulate no token
        return c.json({ connected: false });
      });

      // Minimal /issues route
      app.get('/issues', (c) => {
        const projectId = c.req.query('projectId');
        if (!projectId) return c.json({ error: 'projectId is required' }, 400);
        return c.json({ issues: [], hasMore: false, owner: 'test', repo: 'test' });
      });

      // Minimal /oauth/disconnect
      app.delete('/oauth/disconnect', (c) => {
        return c.json({ ok: true });
      });

      // Minimal /user route — no token
      app.get('/user', (c) => {
        return c.json({ error: 'Not connected to GitHub' }, 401);
      });

      // Minimal /repos — no token
      app.get('/repos', (c) => {
        return c.json({ error: 'Not connected to GitHub' }, 401);
      });
    });

    test('GET /status returns connected: false when no token', async () => {
      const res = await app.request('/status');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.connected).toBe(false);
    });

    test('GET /issues returns 400 when projectId missing', async () => {
      const res = await app.request('/issues');
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('projectId');
    });

    test('GET /issues returns issues for valid project', async () => {
      const res = await app.request('/issues?projectId=p1');
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.issues).toBeDefined();
      expect(Array.isArray(body.issues)).toBe(true);
    });

    test('DELETE /oauth/disconnect returns ok', async () => {
      const res = await app.request('/oauth/disconnect', { method: 'DELETE' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
    });

    test('GET /user returns 401 when not connected', async () => {
      const res = await app.request('/user');
      expect(res.status).toBe(401);
    });

    test('GET /repos returns 401 when not connected', async () => {
      const res = await app.request('/repos');
      expect(res.status).toBe(401);
    });
  });

  // POST /pr-merge — request validation runs before any GitHub/service call, so
  // these paths are deterministic without stubbing the network or DB.
  describe('POST /pr-merge validation', () => {
    let app: Hono<HonoEnv>;

    beforeEach(() => {
      app = new Hono<HonoEnv>();
      // Mount the real route behind a middleware that injects a userId, mirroring
      // the auth middleware in production.
      app.use('*', async (c, next) => {
        c.set('userId', 'user-1');
        await next();
      });
      app.route('/', prRoutes);
    });

    test('returns 400 when projectId and prNumber are missing', async () => {
      const res = await app.request('/pr-merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('projectId');
    });

    test('returns 400 when prNumber is missing', async () => {
      const res = await app.request('/pr-merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'p1' }),
      });
      expect(res.status).toBe(400);
    });

    test('returns 400 for an invalid merge method', async () => {
      const res = await app.request('/pr-merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: 'p1', prNumber: 7, method: 'fast-forward' }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain('merge method');
    });
  });
});
