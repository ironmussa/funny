import { existsSync } from 'fs';
import { rm } from 'fs/promises';
import { resolve, isAbsolute, join } from 'path';

import { cloneRepository } from '@funny/core/git';
import type { GitHubRepo, WSCloneProgressData } from '@funny/shared';
import { stripUrlCredentials } from '@funny/shared/activities';
import { retryAsync } from '@funny/shared/async';
import { badRequest, conflict, processError } from '@funny/shared/errors';
import { Hono, type Context } from 'hono';
import { err, ok, type Result } from 'neverthrow';

import { log } from '../../lib/logger.js';
import { trackActivity, type ActivityHandle } from '../../services/activity-tracker.js';
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
 * Clone directories with a clone still running. A large repository takes
 * minutes, so the route answers before git finishes; this refuses a second
 * clone into the same directory meanwhile.
 */
const clonesInFlight = new Set<string>();

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

  if (clonesInFlight.has(clonePath)) {
    return resultToResponse(c, err(conflict(`A clone into ${clonePath} is already running`)));
  }
  if (existsSync(clonePath)) {
    return resultToResponse(c, err(badRequest(`Directory already exists: ${clonePath}`)));
  }

  return { repoName, clonePath };
}

// ── POST /clone — start a clone that creates the project when done ──

const MAX_CREATE_ATTEMPTS = 3;

/** Unregisters a failed clone's directory, logging (not throwing) a failed removal. */
async function removeCloneDir(clonePath: string): Promise<void> {
  await rm(clonePath, { recursive: true, force: true }).catch((rmErr) => {
    log.warn('Failed to clean up clone directory after a failed clone', {
      namespace: 'github-routes',
      clonePath,
      error: rmErr?.message ?? String(rmErr),
    });
  });
}

/**
 * Registers the cloned directory as a project. The data channel to the server
 * can be transiently saturated, or reconnecting, right after a slow clone, so
 * a thrown failure is retried; a neverthrow `err` is a definitive answer.
 * Answers the project id, or the error message.
 */
async function registerClonedProject(
  repoName: string,
  clonePath: string,
  userId: string,
): Promise<{ projectId: string } | { error: string }> {
  try {
    const result = await retryAsync(
      async (_signal, attempt) => {
        try {
          return await getServices().projects.createProject(repoName, clonePath, userId);
        } catch (error: any) {
          log.warn('createProject attempt failed', {
            namespace: 'github-routes',
            attempt,
            maxAttempts: MAX_CREATE_ATTEMPTS,
            clonePath,
            error: error?.message ?? String(error),
          });
          throw error;
        }
      },
      { times: MAX_CREATE_ATTEMPTS - 1, delayMs: (retry) => 1_000 * retry },
    );
    if (result.isErr()) return { error: result.error.message };
    return { projectId: result.value.id };
  } catch (error: any) {
    log.error('createProject failed after successful clone', {
      namespace: 'github-routes',
      clonePath,
      attempts: MAX_CREATE_ATTEMPTS,
      error: error?.message ?? String(error),
    });
    return { error: error?.message ?? 'Failed to register project after clone' };
  }
}

interface CloneJob {
  cloneId: string;
  cloneUrl: string;
  clonePath: string;
  repoName: string;
  userId: string;
}

/**
 * Runs the clone and registers the project, reporting every step as a
 * `clone:progress` event. The last event has `status: 'done'` with the
 * project id, or `status: 'failed'` with the error. Resolves to the created
 * project or the error, for its activity; never rejects.
 */
async function runClone(
  job: CloneJob,
  activity: ActivityHandle,
): Promise<Result<{ projectId: string }, string>> {
  const { cloneId, cloneUrl, clonePath, repoName, userId } = job;
  // No thread: the event travels as an unscoped user event (runner-protocol
  // `isRunnerUserEventType`), matched by `cloneId` in the browser.
  const emitProgress = (data: Omit<WSCloneProgressData, 'cloneId'>) => {
    wsBroker.emitToUser(userId, {
      type: 'clone:progress',
      threadId: '',
      data: { cloneId, ...data },
    });
  };
  const fail = (error: string, extra: Record<string, unknown> = {}) => {
    log.error('Clone failed', {
      namespace: 'github-routes',
      cloneId,
      clonePath,
      repoName,
      error,
      ...extra,
    });
    emitProgress({ phase: 'Clone failed', percent: 0, status: 'failed', error });
    return err(error);
  };

  try {
    // The token travels in git's environment, scoped to https://github.com/,
    // never in the clone URL (argv, `.git/config`).
    const resolved = await resolveGithubToken(userId);
    const startedAt = Date.now();
    emitProgress({ phase: 'Starting clone...', percent: 0, status: 'running' });
    activity.step('Cloning');
    const cloned = await cloneRepository(cloneUrl, clonePath, {
      githubToken: resolved?.token ?? null,
      onProgress: (rawLine) => {
        // funny never puts the token in the URL, but a pasted URL may carry one.
        const line = redactGithubToken(rawLine);
        // Parse percentage from git output like "Receiving objects:  45% (123/456)"
        const pctMatch = line.match(/(\d+)%/);
        if (pctMatch) activity.progress(Number.parseInt(pctMatch[1], 10));
        emitProgress({
          phase: line,
          percent: pctMatch ? Number.parseInt(pctMatch[1], 10) : undefined,
          status: 'running',
        });
      },
    });
    if (cloned.isErr()) {
      const failure = cloned.error;
      const isProcess = failure.type === 'PROCESS_ERROR';
      const detail = redactGithubToken((isProcess && failure.stderr?.trim()) || failure.message);
      return fail(detail, {
        exitCode: (isProcess && failure.exitCode) || 1,
        durationMs: Date.now() - startedAt,
      });
    }
    log.info('Clone finished', {
      namespace: 'github-routes',
      cloneId,
      clonePath,
      durationMs: Date.now() - startedAt,
    });
    emitProgress({ phase: 'Creating project...', percent: 100, status: 'running' });
    activity.step('Creating project');

    const registered = await registerClonedProject(repoName, clonePath, userId);
    if ('error' in registered) {
      await removeCloneDir(clonePath);
      return fail(registered.error, { stage: 'create-project' });
    }
    emitProgress({
      phase: 'Clone complete',
      percent: 100,
      status: 'done',
      projectId: registered.projectId,
    });
    activity.result({ projectId: registered.projectId });
    return ok({ projectId: registered.projectId });
  } catch (error: any) {
    return fail(error?.message ?? String(error));
  }
}

/**
 * Starts the clone and answers 202 with its id at once: a large repository
 * takes longer than the server waits for a runner response, so the outcome
 * arrives as `clone:progress` events instead. The client may pick the id, so
 * it can match events that arrive before this response.
 */
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

  const cloneId = parsed.value.cloneId ?? crypto.randomUUID();
  clonesInFlight.add(clonePath);
  // Tracked as an activity under the client's clone id, so its outcome is kept
  // even when nobody is watching (track-background-activities). The server
  // strips the URL's credentials and every field the kind does not declare.
  void trackActivity(
    {
      id: cloneId,
      kind: 'project.clone',
      userId,
      title: `Clone ${repoName}`,
      input: { cloneUrl: stripUrlCredentials(cloneUrl), destinationPath, name: repoName },
    },
    (activity) => runClone({ cloneId, cloneUrl, clonePath, repoName, userId }, activity),
  ).finally(() => clonesInFlight.delete(clonePath));

  return c.json({ cloneId }, 202);
});
