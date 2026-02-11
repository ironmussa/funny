/**
 * GitHub OAuth (Device Flow) + repo listing + clone routes.
 * Mounted at /api/github.
 */

import { Hono } from 'hono';
import { resolve, isAbsolute, join } from 'path';
import { existsSync } from 'fs';
import { validate, cloneRepoSchema, githubPollSchema } from '../validation/schemas.js';
import { resultToResponse } from '../utils/result-response.js';
import { execute } from '../utils/process.js';
import * as profileService from '../services/profile-service.js';
import * as pm from '../services/project-manager.js';
import { badRequest, internal } from '@a-parallel/shared/errors';
import { ok, err } from 'neverthrow';
import type { GitHubRepo } from '@a-parallel/shared';

const GITHUB_API = 'https://api.github.com';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

function getClientId(): string | null {
  return process.env.GITHUB_CLIENT_ID || null;
}

/** Make an authenticated request to the GitHub API. */
async function githubApiFetch(path: string, token: string, init?: RequestInit): Promise<Response> {
  return fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      ...init?.headers,
    },
  });
}

export const githubRoutes = new Hono();

// ── GET /status — check GitHub connection ──────────────────

githubRoutes.get('/status', async (c) => {
  const userId = c.get('userId') as string;
  const token = profileService.getGithubToken(userId);
  if (!token) {
    return c.json({ connected: false });
  }

  try {
    const res = await githubApiFetch('/user', token);
    if (!res.ok) {
      return c.json({ connected: false });
    }
    const user = await res.json() as { login: string };
    return c.json({ connected: true, login: user.login });
  } catch {
    return c.json({ connected: false });
  }
});

// ── POST /oauth/device — start Device Flow ─────────────────

githubRoutes.post('/oauth/device', async (c) => {
  const clientId = getClientId();
  if (!clientId) {
    return c.json({ error: 'GITHUB_CLIENT_ID is not configured on the server' }, 500);
  }

  try {
    const res = await fetch(DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        scope: 'repo',
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      return c.json({ error: `GitHub device code request failed: ${body}` }, 502);
    }

    const data = await res.json() as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      expires_in: number;
      interval: number;
    };

    return c.json({
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri,
      expires_in: data.expires_in,
      interval: data.interval,
    });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── POST /oauth/poll — poll for Device Flow token ──────────

githubRoutes.post('/oauth/poll', async (c) => {
  const clientId = getClientId();
  if (!clientId) {
    return c.json({ error: 'GITHUB_CLIENT_ID is not configured' }, 500);
  }

  const userId = c.get('userId') as string;
  const raw = await c.req.json();
  const parsed = validate(githubPollSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const { deviceCode } = parsed.value;

  try {
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        device_code: deviceCode,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

    const data = await res.json() as {
      access_token?: string;
      token_type?: string;
      scope?: string;
      error?: string;
      error_description?: string;
      interval?: number;
    };

    if (data.error) {
      if (data.error === 'authorization_pending') {
        return c.json({ status: 'pending' });
      }
      if (data.error === 'slow_down') {
        return c.json({ status: 'pending', interval: data.interval });
      }
      if (data.error === 'expired_token') {
        return c.json({ status: 'expired' });
      }
      if (data.error === 'access_denied') {
        return c.json({ status: 'denied' });
      }
      return c.json({ error: data.error_description || data.error }, 400);
    }

    if (data.access_token) {
      // Store the token encrypted in the user's profile
      profileService.updateProfile(userId, { githubToken: data.access_token });
      return c.json({ status: 'success', scopes: data.scope });
    }

    return c.json({ status: 'pending' });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── DELETE /oauth/disconnect — clear GitHub token ──────────

githubRoutes.delete('/oauth/disconnect', (c) => {
  const userId = c.get('userId') as string;
  profileService.updateProfile(userId, { githubToken: null });
  return c.json({ ok: true });
});

// ── GET /user — get authenticated GitHub user ──────────────

githubRoutes.get('/user', async (c) => {
  const userId = c.get('userId') as string;
  const token = profileService.getGithubToken(userId);
  if (!token) {
    return c.json({ error: 'Not connected to GitHub' }, 401);
  }

  const res = await githubApiFetch('/user', token);
  if (!res.ok) {
    return c.json({ error: 'Failed to fetch GitHub user' }, 502);
  }

  const user = await res.json() as { login: string; avatar_url: string; name: string | null };
  return c.json({ login: user.login, avatar_url: user.avatar_url, name: user.name });
});

// ── GET /repos — list repos with optional search ───────────

githubRoutes.get('/repos', async (c) => {
  const userId = c.get('userId') as string;
  const token = profileService.getGithubToken(userId);
  if (!token) {
    return c.json({ error: 'Not connected to GitHub' }, 401);
  }

  const page = Number(c.req.query('page')) || 1;
  const perPage = Math.min(Number(c.req.query('per_page')) || 30, 100);
  const search = c.req.query('search') || '';
  const sort = c.req.query('sort') || 'updated';

  try {
    let repos: GitHubRepo[];
    let hasMore: boolean;

    if (search) {
      // Use search API to find repos matching query
      const userRes = await githubApiFetch('/user', token);
      if (!userRes.ok) {
        return c.json({ error: 'Failed to fetch GitHub user for search' }, 502);
      }
      const user = await userRes.json() as { login: string };
      const q = encodeURIComponent(`user:${user.login} ${search} fork:true`);
      const searchRes = await githubApiFetch(
        `/search/repositories?q=${q}&sort=${sort}&per_page=${perPage}&page=${page}`,
        token
      );
      if (!searchRes.ok) {
        return c.json({ error: 'GitHub search failed' }, 502);
      }
      const data = await searchRes.json() as { items: GitHubRepo[]; total_count: number };
      repos = data.items;
      hasMore = data.total_count > page * perPage;
    } else {
      // List user repos directly
      const res = await githubApiFetch(
        `/user/repos?sort=${sort}&direction=desc&per_page=${perPage}&page=${page}&affiliation=owner,collaborator,organization_member`,
        token
      );
      if (!res.ok) {
        return c.json({ error: 'Failed to fetch repos' }, 502);
      }
      repos = await res.json() as GitHubRepo[];
      // GitHub uses Link header for pagination
      const linkHeader = res.headers.get('Link') || '';
      hasMore = linkHeader.includes('rel="next"');
    }

    return c.json({ repos, hasMore });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── POST /clone — clone a repo and create project ──────────

githubRoutes.post('/clone', async (c) => {
  const userId = c.get('userId') as string;
  const raw = await c.req.json();
  const parsed = validate(cloneRepoSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const { cloneUrl, destinationPath, name } = parsed.value;

  // Validate destination
  if (!isAbsolute(destinationPath)) {
    return resultToResponse(c, err(badRequest('Destination path must be absolute')));
  }

  const parentDir = resolve(destinationPath);
  if (!existsSync(parentDir)) {
    return resultToResponse(c, err(badRequest(`Destination directory does not exist: ${parentDir}`)));
  }

  // Derive repo name from URL if not provided
  const repoName = name || cloneUrl.split('/').pop()?.replace(/\.git$/, '') || 'repo';
  const clonePath = join(parentDir, repoName);

  if (existsSync(clonePath)) {
    return resultToResponse(c, err(badRequest(`Directory already exists: ${clonePath}`)));
  }

  // Inject token into clone URL for private repo access
  const token = profileService.getGithubToken(userId);
  let authenticatedUrl = cloneUrl;
  if (token && cloneUrl.startsWith('https://github.com/')) {
    authenticatedUrl = cloneUrl.replace(
      'https://github.com/',
      `https://x-access-token:${token}@github.com/`
    );
  }

  try {
    await execute('git', ['clone', authenticatedUrl, clonePath], {
      timeout: 300_000, // 5 minutes for large repos
    });
  } catch (error: any) {
    // Sanitize error message — never leak the token
    const safeMsg = (error.message || String(error)).replace(
      /x-access-token:[^@]+@/g,
      'x-access-token:***@'
    );
    return resultToResponse(c, err(internal(`Clone failed: ${safeMsg}`)));
  }

  // Create the project
  const result = pm.createProject(repoName, clonePath, userId);
  if (result.isErr()) {
    return resultToResponse(c, result);
  }

  return c.json(result.value, 201);
});

export default githubRoutes;
