import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { resolve, isAbsolute, join } from 'path';

import { cloneRepository } from '@funny/core/git';
import type { GitHubRepo, WSCloneProgressData } from '@funny/shared';
import { retryAsync } from '@funny/shared/async';
import { badRequest, conflict, processError } from '@funny/shared/errors';
import { Hono, type Context } from 'hono';
import { err } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { getServices } from '../../services/service-registry.js';
import { wsBroker } from '../../services/ws-broker.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { redactGithubToken } from '../../utils/github-clone-url.js';
import { requirePickerPath } from '../../utils/path-scope.js';
import { resultToResponse } from '../../utils/result-response.js';
import { validate, cloneRepoSchema } from '../../validation/schemas.js';
import { githubApiFetch, resolveGithubToken } from './helpers.js';
import { readPaging, readRepoSort } from './query.js';

export const repoRoutes = new Hono<HonoEnv>();

/**
 * Security (#179): the clone goes into `join(parentDir, name)`, so the name
 * (given, or taken from the URL) must be one path segment: no separator on
 * either platform, not `.` or `..`, no NUL.
 */
function isSingleDirName(name: string): boolean {
  return name !== '.' && name !== '..' && !/[/\\\0]/.test(name);
}

// ── GET /repos — list repos with optional search ───────────

repoRoutes.get('/repos', async (c) => {
  const userId = c.get('userId') as string;
  const resolved = await resolveGithubToken(userId);
  if (!resolved) {
    return c.json({ error: 'Not connected to GitHub' }, 401);
  }
  const token = resolved.token;

  const { page, perPage } = readPaging(c, 30);
  const search = c.req.query('search') || '';
  const sortResult = readRepoSort(c);
  if (sortResult.isErr()) return c.json({ error: sortResult.error.message }, 400);
  const sort = sortResult.value;

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

/**
 * Where a clone goes: `destinationPath` joined with the repository name (given,
 * or taken from the URL). Answers the error response when the destination is
 * not an existing directory in picker scope, the name is not a single path
 * segment, or the clone directory is out of scope or already exists.
 */
async function resolveCloneTarget(
  c: Context<HonoEnv>,
  cloneUrl: string,
  destinationPath: string,
  name: string | undefined,
): Promise<Response | { repoName: string; clonePath: string }> {
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
  if (!isSingleDirName(repoName)) {
    return resultToResponse(c, err(badRequest(`Invalid repository name: ${repoName}`)));
  }
  const clonePath = join(parentDir, repoName);

  // The name can still pick a blocked directory under an allowed parent
  // (`$HOME` + `.kube`), so the clone path itself must be in picker scope.
  const clonePathDenied = await requirePickerPath(clonePath);
  if (clonePathDenied) return clonePathDenied;

  if (existsSync(clonePath)) {
    return resultToResponse(c, err(badRequest(`Directory already exists: ${clonePath}`)));
  }

  return { repoName, clonePath };
}

// ── POST /clone — clone a repo and create project ──────────

repoRoutes.post('/clone', async (c) => {
  const userId = c.get('userId') as string;
  const raw = await c.req.json();
  const parsed = validate(cloneRepoSchema, raw);
  if (parsed.isErr()) return resultToResponse(c, parsed);

  const { cloneUrl, destinationPath, name } = parsed.value;

  const target = await resolveCloneTarget(c, cloneUrl, destinationPath, name);
  if (target instanceof Response) return target;
  const { repoName, clonePath } = target;

  // Check for duplicate project name before cloning
  if (await getServices().projects.projectNameExists(repoName, userId)) {
    return resultToResponse(
      c,
      err(conflict(`A project with this name already exists: ${repoName}`)),
    );
  }

  // The token travels in git's environment, scoped to https://github.com/,
  // never in the clone URL (argv, `.git/config`).
  const resolved = await resolveGithubToken(userId);
  const token = resolved?.token ?? null;

  // Clone ID for WebSocket progress events
  const cloneId = `clone:${Date.now()}`;

  const emitProgress = (data: Omit<WSCloneProgressData, 'cloneId'>) => {
    wsBroker.emitToUser(userId, {
      type: 'clone:progress',
      threadId: cloneId,
      data: { cloneId, ...data },
    });
  };

  emitProgress({ phase: 'Starting clone...', percent: 0 });
  const cloned = await cloneRepository(cloneUrl, clonePath, {
    githubToken: token,
    onProgress: (rawLine) => {
      // funny never puts the token in the URL, but a pasted URL may carry one.
      const line = redactGithubToken(rawLine);
      // Parse percentage from git output like "Receiving objects:  45% (123/456)"
      const pctMatch = line.match(/(\d+)%/);
      emitProgress({
        phase: line,
        percent: pctMatch ? Number.parseInt(pctMatch[1], 10) : undefined,
      });
    },
  });
  if (cloned.isErr()) {
    const failure = cloned.error;
    const isProcess = failure.type === 'PROCESS_ERROR';
    const detail = redactGithubToken((isProcess && failure.stderr?.trim()) || failure.message);
    const exitCode = (isProcess && failure.exitCode) || 1;
    emitProgress({ phase: 'Clone failed', percent: 0, error: detail });
    return resultToResponse(c, err(processError(`Clone failed: ${detail}`, exitCode, detail)));
  }
  emitProgress({ phase: 'Clone complete', percent: 100 });

  // Create the project. The data channel to the server (Socket.IO) can be
  // transiently saturated or in the middle of a reconnect right after a slow
  // git clone, which causes `data:create_project` to time out even though a
  // retry a second later succeeds. Retry a few times before giving up.
  const MAX_ATTEMPTS = 3;
  let result;
  let lastError: any = null;
  try {
    result = await retryAsync(
      async (_signal, attempt) => {
        try {
          return await getServices().projects.createProject(repoName, clonePath, userId);
        } catch (error: any) {
          log.warn('createProject attempt failed', {
            namespace: 'github-routes',
            attempt,
            maxAttempts: MAX_ATTEMPTS,
            clonePath,
            error: error?.message ?? String(error),
          });
          throw error;
        }
      },
      { times: MAX_ATTEMPTS - 1, delayMs: (retry) => 1_000 * retry },
    );
  } catch (error: any) {
    lastError = error;
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
