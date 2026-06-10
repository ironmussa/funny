import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { resolve, isAbsolute, join } from 'path';

import type { GitHubRepo, WSCloneProgressData } from '@funny/shared';
import { badRequest, conflict, processError } from '@funny/shared/errors';
import { Hono } from 'hono';
import { err } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { getServices } from '../../services/service-registry.js';
import { wsBroker } from '../../services/ws-broker.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { requirePickerPath } from '../../utils/path-scope.js';
import { resultToResponse } from '../../utils/result-response.js';
import { validate, cloneRepoSchema } from '../../validation/schemas.js';
import { githubApiFetch, resolveGithubToken } from './helpers.js';

export const repoRoutes = new Hono<HonoEnv>();

// ── GET /repos — list repos with optional search ───────────

repoRoutes.get('/repos', async (c) => {
  const userId = c.get('userId') as string;
  const resolved = await resolveGithubToken(userId);
  if (!resolved) {
    return c.json({ error: 'Not connected to GitHub' }, 401);
  }
  const token = resolved.token;

  const page = Number(c.req.query('page')) || 1;
  const perPage = Math.min(Number(c.req.query('per_page')) || 30, 100);
  const search = c.req.query('search') || '';
  const sort = c.req.query('sort') || 'updated';

  try {
    let repos: GitHubRepo[];
    let hasMore: boolean;

    if (search) {
      // Search must scope the query to every account the user can see repos
      // from — their own login plus each org they belong to. Without the org
      // `user:` qualifiers, repos like `goliiive/banplus-facade` would never
      // match even though they appear in the default (non-search) listing.
      const [userRes, orgsRes] = await Promise.all([
        githubApiFetch('/user', token),
        githubApiFetch('/user/orgs?per_page=100', token),
      ]);
      if (!userRes.ok) {
        return c.json({ error: 'Failed to fetch GitHub user for search' }, 502);
      }
      const user = (await userRes.json()) as { login: string };
      const orgLogins: string[] = orgsRes.ok
        ? ((await orgsRes.json()) as Array<{ login: string }>).map((o) => o.login)
        : [];
      if (!orgsRes.ok) {
        log.warn('github orgs fetch failed; search will be limited to user repos', {
          namespace: 'github-routes',
          status: orgsRes.status,
        });
      }
      const owners = [user.login, ...orgLogins];
      const ownerQualifiers = owners.map((o) => `user:${o}`).join(' ');
      const q = encodeURIComponent(`${ownerQualifiers} ${search} fork:true`);
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

repoRoutes.post('/clone', async (c) => {
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

  // Security: constrain the clone destination to the same $HOME-minus-
  // credential-dirs picker scope every other path-taking endpoint enforces,
  // instead of allowing a write into any runner-writable directory.
  const denied = await requirePickerPath(parentDir);
  if (denied) return denied;

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
  if (await getServices().projects.projectNameExists(repoName, userId)) {
    return resultToResponse(
      c,
      err(conflict(`A project with this name already exists: ${repoName}`)),
    );
  }

  // Inject token into clone URL for private repo access
  const resolved = await resolveGithubToken(userId);
  const token = resolved?.token ?? null;
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
      return resultToResponse(
        c,
        err(processError(`Clone failed: ${errorMsg}`, proc.exitCode ?? 1, errorMsg)),
      );
    }

    // Security: when a token was injected into the clone URL, git persists the
    // full `https://x-access-token:<token>@github.com/...` URL in
    // <repo>/.git/config under [remote "origin"]. Reset the remote to the
    // clean URL so the PAT is not left on disk for every later process/agent
    // that reads the repo's git config.
    if (authenticatedUrl !== cloneUrl) {
      const reset = Bun.spawn(['git', '-C', clonePath, 'remote', 'set-url', 'origin', cloneUrl], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      await reset.exited;
      if (reset.exitCode !== 0) {
        log.warn('Failed to strip credential from cloned repo remote', {
          namespace: 'github',
          clonePath,
        });
      }
    }

    emitProgress({ phase: 'Clone complete', percent: 100 });
  } catch (error: any) {
    // Sanitize error message — never leak the token
    const safeMsg = (error.message || String(error)).replace(
      /x-access-token:[^@]+@/g,
      'x-access-token:***@',
    );
    emitProgress({ phase: 'Clone failed', percent: 0, error: safeMsg });
    return resultToResponse(c, err(processError(`Clone failed: ${safeMsg}`, 1, safeMsg)));
  }

  // Create the project. The data channel to the server (Socket.IO) can be
  // transiently saturated or in the middle of a reconnect right after a slow
  // git clone, which causes `data:create_project` to time out even though a
  // retry a second later succeeds. Retry a few times before giving up.
  let result;
  let lastError: any = null;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      result = await getServices().projects.createProject(repoName, clonePath, userId);
      lastError = null;
      break;
    } catch (error: any) {
      lastError = error;
      log.warn('createProject attempt failed', {
        namespace: 'github-routes',
        attempt,
        maxAttempts: MAX_ATTEMPTS,
        clonePath,
        error: error?.message ?? String(error),
      });
      if (attempt < MAX_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, 1_000 * attempt));
      }
    }
  }

  if (lastError) {
    log.error('createProject failed after successful clone', {
      namespace: 'github-routes',
      clonePath,
      attempts: MAX_ATTEMPTS,
      error: lastError?.message ?? String(lastError),
    });
    await rm(clonePath, { recursive: true, force: true }).catch((rmErr) => {
      log.warn('Failed to clean up clone directory after createProject error', {
        namespace: 'github-routes',
        clonePath,
        error: rmErr?.message ?? String(rmErr),
      });
    });
    const msg = lastError?.message ?? 'Failed to register project after clone';
    emitProgress({ phase: 'Clone failed', percent: 0, error: msg });
    return resultToResponse(c, err(processError(`Clone failed: ${msg}`, 1, msg)));
  }

  if (!result || result.isErr()) {
    const errMsg = result?.isErr() ? result.error.message : 'Unknown error';
    await rm(clonePath, { recursive: true, force: true }).catch((rmErr) => {
      log.warn('Failed to clean up clone directory after createProject error', {
        namespace: 'github-routes',
        clonePath,
        error: rmErr?.message ?? String(rmErr),
      });
    });
    emitProgress({ phase: 'Clone failed', percent: 0, error: errMsg });
    return result
      ? resultToResponse(c, result)
      : resultToResponse(c, err(processError(`Clone failed: ${errMsg}`, 1, errMsg)));
  }

  return c.json(result.value, 201);
});
