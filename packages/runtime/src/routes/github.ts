/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 */

/**
 * GitHub OAuth (Device Flow) + repo listing + clone routes.
 * Mounted at /api/github.
 */

import { existsSync } from 'fs';
import { resolve, isAbsolute, join } from 'path';

import { getRemoteUrl } from '@funny/core/git';
import type { GitHubRepo, GitHubIssue, WSCloneProgressData } from '@funny/shared';
import { badRequest, conflict, internal } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';

import * as profileService from '../services/profile-service.js';
import * as pm from '../services/project-manager.js';
import { wsBroker } from '../services/ws-broker.js';
import type { HonoEnv } from '../types/hono-env.js';
import { resultToResponse } from '../utils/result-response.js';
import { validate, cloneRepoSchema, githubPollSchema } from '../validation/schemas.js';

const GITHUB_API = 'https://api.github.com';
const DEVICE_CODE_URL = 'https://github.com/login/device/code';
const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

function getClientId(): string | null {
  return process.env.GITHUB_CLIENT_ID || null;
}

/** Extract owner/repo from a GitHub remote URL. Returns null if not a GitHub URL. */
function parseGithubOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  return null;
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

export const githubRoutes = new Hono<HonoEnv>();

// ── GET /status — check GitHub connection ──────────────────

githubRoutes.get('/status', async (c) => {
  const userId = c.get('userId') as string;

  // First check if a token row exists (without decrypting — decrypt can fail
  // if the encryption key rotated, but the token is still "configured").
  const profile = await profileService.getProfile(userId);
  if (!profile?.hasGithubToken) {
    return c.json({ connected: false });
  }

  // Token is configured — try to fetch login for display, but always report connected.
  const token = await profileService.getGithubToken(userId);
  if (token) {
    try {
      const res = await githubApiFetch('/user', token);
      if (res.ok) {
        const user = (await res.json()) as { login: string };
        return c.json({ connected: true, login: user.login });
      }
    } catch {
      // Ignore — we still know the token exists
    }
  }

  return c.json({ connected: true });
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

    const data = (await res.json()) as {
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

    const data = (await res.json()) as {
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
      await profileService.updateProfile(userId, { githubToken: data.access_token });
      return c.json({ status: 'success', scopes: data.scope });
    }

    return c.json({ status: 'pending' });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── DELETE /oauth/disconnect — clear GitHub token ──────────

githubRoutes.delete('/oauth/disconnect', async (c) => {
  const userId = c.get('userId') as string;
  await profileService.updateProfile(userId, { githubToken: null });
  return c.json({ ok: true });
});

// ── GET /user — get authenticated GitHub user ──────────────

githubRoutes.get('/user', async (c) => {
  const userId = c.get('userId') as string;
  const token = await profileService.getGithubToken(userId);
  if (!token) {
    return c.json({ error: 'Not connected to GitHub' }, 401);
  }

  const res = await githubApiFetch('/user', token);
  if (!res.ok) {
    return c.json({ error: 'Failed to fetch GitHub user' }, 502);
  }

  const user = (await res.json()) as { login: string; avatar_url: string; name: string | null };
  return c.json({ login: user.login, avatar_url: user.avatar_url, name: user.name });
});

// ── GET /repos — list repos with optional search ───────────

githubRoutes.get('/repos', async (c) => {
  const userId = c.get('userId') as string;
  const token = await profileService.getGithubToken(userId);
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
      const user = (await userRes.json()) as { login: string };
      const q = encodeURIComponent(`user:${user.login} ${search} fork:true`);
      const searchRes = await githubApiFetch(
        `/search/repositories?q=${q}&sort=${sort}&per_page=${perPage}&page=${page}`,
        token,
      );
      if (!searchRes.ok) {
        return c.json({ error: 'GitHub search failed' }, 502);
      }
      const data = (await searchRes.json()) as { items: GitHubRepo[]; total_count: number };
      repos = data.items;
      hasMore = data.total_count > page * perPage;
    } else {
      // List user repos directly
      const res = await githubApiFetch(
        `/user/repos?sort=${sort}&direction=desc&per_page=${perPage}&page=${page}&affiliation=owner,collaborator,organization_member`,
        token,
      );
      if (!res.ok) {
        return c.json({ error: 'Failed to fetch repos' }, 502);
      }
      repos = (await res.json()) as GitHubRepo[];
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
    return resultToResponse(
      c,
      err(badRequest(`Destination directory does not exist: ${parentDir}`)),
    );
  }

  // Derive repo name from URL if not provided
  const repoName =
    name ||
    cloneUrl
      .split('/')
      .pop()
      ?.replace(/\.git$/, '') ||
    'repo';
  const clonePath = join(parentDir, repoName);

  if (existsSync(clonePath)) {
    return resultToResponse(c, err(badRequest(`Directory already exists: ${clonePath}`)));
  }

  // Check for duplicate project name before cloning
  if (await pm.projectNameExists(repoName, userId)) {
    return resultToResponse(
      c,
      err(conflict(`A project with this name already exists: ${repoName}`)),
    );
  }

  // Inject token into clone URL for private repo access
  const token = await profileService.getGithubToken(userId);
  let authenticatedUrl = cloneUrl;
  if (token && cloneUrl.startsWith('https://github.com/')) {
    authenticatedUrl = cloneUrl.replace(
      'https://github.com/',
      `https://x-access-token:${token}@github.com/`,
    );
  }

  // Clone ID for WebSocket progress events
  const cloneId = `clone:${Date.now()}`;

  const emitProgress = (data: Omit<WSCloneProgressData, 'cloneId'>) => {
    wsBroker.emitToUser(userId, {
      type: 'clone:progress',
      threadId: cloneId,
      data: { cloneId, ...data },
    });
  };

  try {
    emitProgress({ phase: 'Starting clone...', percent: 0 });

    const proc = Bun.spawn(['git', 'clone', '--progress', authenticatedUrl, clonePath], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    // Git clone progress goes to stderr
    const decoder = new TextDecoder();
    let stderrBuffer = '';

    const readStderr = async () => {
      if (!proc.stderr) return;
      for await (const chunk of proc.stderr) {
        stderrBuffer += decoder.decode(chunk, { stream: true });
        // Git progress uses \r for in-place updates
        const lines = stderrBuffer.split(/[\r\n]+/);
        stderrBuffer = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          // Sanitize — never leak the token
          const safeLine = trimmed.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
          // Parse percentage from git output like "Receiving objects:  45% (123/456)"
          const pctMatch = safeLine.match(/(\d+)%/);
          emitProgress({
            phase: safeLine,
            percent: pctMatch ? Number.parseInt(pctMatch[1], 10) : undefined,
          });
        }
      }
    };

    await Promise.all([readStderr(), proc.exited]);

    if (proc.exitCode !== 0) {
      // Read any remaining stdout for error context
      const stdoutText = await new Response(proc.stdout).text();
      const errorMsg = (stderrBuffer + stdoutText).replace(
        /x-access-token:[^@]+@/g,
        'x-access-token:***@',
      );
      emitProgress({ phase: 'Clone failed', percent: 0, error: errorMsg });
      return resultToResponse(c, err(internal(`Clone failed: ${errorMsg}`)));
    }

    emitProgress({ phase: 'Clone complete', percent: 100 });
  } catch (error: any) {
    // Sanitize error message — never leak the token
    const safeMsg = (error.message || String(error)).replace(
      /x-access-token:[^@]+@/g,
      'x-access-token:***@',
    );
    emitProgress({ phase: 'Clone failed', percent: 0, error: safeMsg });
    return resultToResponse(c, err(internal(`Clone failed: ${safeMsg}`)));
  }

  // Create the project
  const result = await pm.createProject(repoName, clonePath, userId);
  if (result.isErr()) {
    return resultToResponse(c, result);
  }

  return c.json(result.value, 201);
});

// ── GET /issues — list GitHub issues for a project ──────

githubRoutes.get('/issues', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.query('projectId');
  if (!projectId) {
    return c.json({ error: 'projectId is required' }, 400);
  }

  const project = await pm.getProject(projectId);
  if (!project) {
    return c.json({ error: 'Project not found' }, 404);
  }

  // Get remote URL from the project's git repo
  const remoteResult = await getRemoteUrl(project.path);
  if (remoteResult.isErr() || !remoteResult.value) {
    return c.json({ error: 'Could not determine remote URL for this project' }, 400);
  }

  const parsed = parseGithubOwnerRepo(remoteResult.value);
  if (!parsed) {
    return c.json({ error: 'This project is not hosted on GitHub' }, 400);
  }

  const state = c.req.query('state') || 'open';
  const page = Number(c.req.query('page')) || 1;
  const perPage = Math.min(Number(c.req.query('per_page')) || 30, 100);

  try {
    const apiPath = `/repos/${parsed.owner}/${parsed.repo}/issues?state=${state}&page=${page}&per_page=${perPage}&sort=created&direction=desc`;
    const token = await profileService.getGithubToken(userId);

    let res: Response;
    if (token) {
      res = await githubApiFetch(apiPath, token);
    } else {
      // Public access (works for public repos, rate-limited to ~60 req/hr)
      res = await fetch(`${GITHUB_API}${apiPath}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
    }

    if (!res.ok) {
      const _body = await res.text();
      return c.json({ error: `GitHub API error: ${res.status}` }, 502);
    }

    const rawIssues = (await res.json()) as GitHubIssue[];
    // Filter out pull requests (GitHub API returns PRs as issues too)
    const issues = rawIssues.filter((i) => !i.pull_request);

    const linkHeader = res.headers.get('Link') || '';
    const hasMore = linkHeader.includes('rel="next"');

    return c.json({ issues, hasMore, owner: parsed.owner, repo: parsed.repo });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

export default githubRoutes;
