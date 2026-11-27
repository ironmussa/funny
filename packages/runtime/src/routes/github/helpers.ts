import { execute, getRemoteUrl } from '@funny/core/git';
import type { GitHubIssue, PRIssueComment, PRReactionSummary } from '@funny/shared';
import type { JsonValue } from '@funny/shared/json-validation';
import type { Context } from 'hono';

import { parseGithubOwnerRepo } from '../../lib/github-remote.js';
import { log } from '../../lib/logger.js';
import { getServices } from '../../services/service-registry.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { requireProject } from '../../utils/route-helpers.js';
import {
  cacheKey,
  cooldownRemainingSec,
  getEntry,
  inCooldown,
  isFresh,
  isRateLimited,
  responseFromEntry,
  setCooldownFrom,
  setEntry,
  touchEntry,
} from './github-cache.js';
import { positiveIntParam } from './query.js';

export const GITHUB_API = 'https://api.github.com';
export const DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export { parseGithubOwnerRepo };

export function getClientId(): string | null {
  return process.env.GITHUB_CLIENT_ID || null;
}

/**
 * Make an authenticated request to the GitHub API.
 *
 * GET requests are transparently served through the in-memory cache in
 * {@link file://./github-cache.ts}: a short fresh-TTL window, ETag conditional
 * re-validation (304s are free against the primary rate limit), and a
 * `Retry-After`-honoring cooldown when GitHub rate-limits us. Callers always
 * receive a normal {@link Response} — cache hits are reconstructed bodies.
 * Non-GET requests (merge, etc.) always go straight to the network.
 */
export async function githubApiFetch(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const baseHeaders = new Headers(init?.headers);
  if (!baseHeaders.has('Accept')) baseHeaders.set('Accept', 'application/vnd.github+json');
  baseHeaders.set('Authorization', `Bearer ${token}`);
  baseHeaders.set('X-GitHub-Api-Version', '2022-11-28');

  // Writes are never cached and must not be short-circuited by a cooldown.
  if (method !== 'GET') {
    return fetch(`${GITHUB_API}${path}`, { ...init, headers: baseHeaders });
  }

  const now = Date.now();
  const key = cacheKey(token, path, baseHeaders.get('Accept') ?? '');
  const cached = getEntry(key);

  // 1. Fresh window — serve cached with zero network cost.
  if (cached && isFresh(cached, now)) {
    return responseFromEntry(cached);
  }

  // 2. Cooldown after a rate-limit hit — avoid GitHub entirely.
  if (inCooldown(token, now)) {
    if (cached) return responseFromEntry(cached);
    return new Response(
      JSON.stringify({
        message: 'GitHub rate limit — backing off',
        retryAfter: cooldownRemainingSec(token, now),
      }),
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'Retry-After': String(cooldownRemainingSec(token, now)),
        },
      },
    );
  }

  // 3. Conditional re-validation when we have a prior ETag.
  const headers = new Headers(baseHeaders);
  if (cached?.etag) headers.set('If-None-Match', cached.etag);

  let res: Response;
  try {
    res = await fetch(`${GITHUB_API}${path}`, { ...init, headers });
  } catch (err) {
    // Network blip — prefer stale data over a hard failure.
    if (cached) return responseFromEntry(cached);
    throw err;
  }

  // 4. Not modified — refresh the freshness stamp and serve cache.
  if (res.status === 304 && cached) {
    touchEntry(cached, now);
    return responseFromEntry(cached);
  }

  // 5. Rate limited — start a cooldown; serve stale if we have it.
  if (isRateLimited(res)) {
    setCooldownFrom(token, res, now);
    if (cached) return responseFromEntry(cached);
    return res;
  }

  // 6. Fresh 200 — cache the body and hand back a re-readable response.
  if (res.ok) {
    const bodyText = await res.text();
    setEntry(key, {
      etag: res.headers.get('ETag'),
      link: res.headers.get('Link'),
      bodyText,
      storedAt: now,
    });
    const out = new Headers(res.headers);
    out.set('X-Funny-Cache', 'miss');
    return new Response(bodyText, { status: res.status, headers: out });
  }

  // Other errors pass through untouched.
  if (res.status >= 500) {
    log.warn('github upstream error', { namespace: 'github-cache', status: res.status, path });
  }
  return res;
}

/**
 * A GraphQL variable as sent in the JSON request body. `undefined` drops the
 * variable from the body, which GraphQL reads as "not provided".
 */
type GraphQLVariableValue = string | number | boolean | null | undefined | readonly string[];

/** Run a GitHub GraphQL query. Returns parsed `data` or throws. */
export async function githubGraphQL<T = any>(
  query: string,
  variables: Record<string, GraphQLVariableValue>,
  token: string,
): Promise<T> {
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GitHub GraphQL error: ${res.status}`);
  // SAFETY: a GraphQL response carries `data` and/or `errors`; the caller's
  // query decides the shape of `data`, which is not validated here.
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
  // SAFETY: without errors GitHub returns `data` for the query; a response
  // missing it is passed on as undefined, as the callers already handled.
  return body.data as T;
}

/**
 * Fetch repository issues via the GitHub Search API.
 *
 * The plain `/repos/{owner}/{repo}/issues` endpoint mixes issues and pull
 * requests in one stream. Filtering PRs out client-side breaks pagination: on
 * a repo with many recent PRs, an entire 30-item page can be all PRs, leaving
 * zero issues even though closed/open issues exist further down. The Search
 * API lets us request `type:issue` so PRs never enter the result set.
 *
 * Returns `null` if the GitHub request fails.
 */
export async function fetchRepoIssues(
  owner: string,
  repo: string,
  opts: {
    state: string;
    page: number;
    perPage: number;
    token: string | null;
    /**
     * A full advanced-search query (the Issues panel's filters) and its sort.
     * It replaces the `repo + type:issue + state` query built here.
     */
    search?: { query: string; sort: string; order: string };
  },
): Promise<{ issues: GitHubIssue[]; hasMore: boolean } | null> {
  const { state, page, perPage, token, search } = opts;
  // `state` accepts open|closed|all — only constrain the query when it is a
  // concrete state, mirroring the GitHub Search qualifier syntax.
  const stateQualifier = state === 'open' || state === 'closed' ? ` state:${state}` : '';
  const q = encodeURIComponent(
    search?.query ?? `repo:${owner}/${repo} type:issue${stateQualifier}`,
  );
  const sortParams = search
    ? `sort=${search.sort}&order=${search.order}&advanced_search=true`
    : 'sort=created&order=desc';
  const apiPath = `/search/issues?q=${q}&${sortParams}&page=${page}&per_page=${perPage}`;

  const res = token
    ? await githubApiFetch(apiPath, token)
    : await fetch(`${GITHUB_API}${apiPath}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
  if (!res.ok) return null;

  // SAFETY: the shape of GitHub's issue search response. Not validated: a
  // missing `items` becomes [] and a missing `total_count` becomes 0 below.
  const body = (await res.json()) as { total_count: number; items: GitHubIssue[] };
  const items = Array.isArray(body.items) ? body.items : [];
  // Defensive: type:issue should already exclude PRs, but keep the guard.
  const issues = items.filter((i) => !i.pull_request);
  const hasMore = page * perPage < (body.total_count ?? 0);
  return { issues, hasMore };
}

function emptyReactions(): PRReactionSummary {
  return {
    total: 0,
    plus1: 0,
    minus1: 0,
    laugh: 0,
    hooray: 0,
    confused: 0,
    heart: 0,
    rocket: 0,
    eyes: 0,
  };
}

export function mapReactions(raw: any): PRReactionSummary {
  if (!raw) return emptyReactions();
  return {
    total: raw.total_count ?? 0,
    plus1: raw['+1'] ?? 0,
    minus1: raw['-1'] ?? 0,
    laugh: raw.laugh ?? 0,
    hooray: raw.hooray ?? 0,
    confused: raw.confused ?? 0,
    heart: raw.heart ?? 0,
    rocket: raw.rocket ?? 0,
    eyes: raw.eyes ?? 0,
  };
}

/** Map a REST issue comment (`/issues/:n/comments`) — PRs and issues share them. */
export function mapIssueComment(cm: any): PRIssueComment {
  return {
    id: cm.id,
    author: cm.user?.login ?? '',
    author_avatar_url: cm.user?.avatar_url ?? '',
    author_association: cm.author_association ?? '',
    body: cm.body ?? '',
    created_at: cm.created_at ?? '',
    updated_at: cm.updated_at ?? '',
    html_url: cm.html_url ?? '',
    reactions: mapReactions(cm.reactions),
  };
}

/** A JSON request body for the GitHub REST API. */
type GithubJsonBody = { [key: string]: JsonValue };

/** Send a JSON body to the GitHub REST API (POST / PATCH / PUT / DELETE). */
export function sendGithubJson(
  path: string,
  token: string,
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  payload: GithubJsonBody,
): Promise<Response> {
  return githubApiFetch(path, token, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

/** REST path of a PR comment: a conversation (`issue`) or a review (`review`) comment. */
export function githubCommentPath(
  repo: { owner: string; repo: string },
  kind: 'issue' | 'review',
  commentId: number,
): string {
  const scope = kind === 'issue' ? 'issues' : 'pulls';
  return `/repos/${repo.owner}/${repo.repo}/${scope}/comments/${commentId}`;
}

/** 502 carrying GitHub's status and response text, for a failed write. */
export async function githubErrorWithBody(c: Context<HonoEnv>, res: Response) {
  const text = await res.text();
  return c.json({ error: `GitHub API error: ${res.status} ${text}` }, 502);
}

/**
 * Every item of a paginated GitHub list (`path` without paging params),
 * 100 per page, or the status of the first page that failed.
 */
export async function fetchAllPages(
  path: string,
  token: string,
  /** The array's field when the page is an object (`jobs` for a run's jobs). */
  field?: string,
): Promise<{ ok: true; items: any[] } | { ok: false; status: number }> {
  const items: any[] = [];
  const separator = path.includes('?') ? '&' : '?';
  for (let page = 1; ; page++) {
    const res = await githubApiFetch(`${path}${separator}per_page=100&page=${page}`, token);
    if (!res.ok) return { ok: false, status: res.status };
    const body = await res.json();
    const data: any[] = (field ? body?.[field] : body) ?? [];
    items.push(...data);
    if (data.length < 100) return { ok: true, items };
  }
}

/** One issue's (or PR's) conversation comments, oldest first, up to 100. */
export function fetchIssueComments(
  repo: { owner: string; repo: string; token: string },
  issueNumber: number,
): Promise<Response> {
  return githubApiFetch(
    `/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}/comments?per_page=100&sort=created&direction=asc`,
    repo.token,
  );
}

/** One issue of the repository (`/repos/:owner/:repo/issues/:n`; a PR number answers a PR). */
export function fetchIssue(
  repo: { owner: string; repo: string; token: string },
  issueNumber: number,
): Promise<Response> {
  return githubApiFetch(`/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}`, repo.token);
}

/**
 * Load a project the caller may access — owner, collaborator (with their own
 * checkout path), or org member; the same rule the git routes apply through
 * `requireProject`. Every failure yields `null` so callers answer 404 and a
 * foreign project id is indistinguishable from a missing one.
 */
export async function requireAccessibleProject(
  projectId: string,
  userId: string | undefined,
  organizationId?: string | null,
) {
  if (!userId) return null;
  const result = await requireProject(projectId, userId, organizationId);
  return result.isOk() ? result.value : null;
}

/** Resolve a GitHub project context: parse remote, token, owner/repo. */
async function resolveGithubProjectContext(
  projectId: string,
  userId: string,
  organizationId: string | null,
): Promise<
  | { ok: true; owner: string; repo: string; token: string }
  | { ok: false; status: 400 | 401 | 404; error: string }
> {
  const project = await requireAccessibleProject(projectId, userId, organizationId);
  if (!project) return { ok: false, status: 404, error: 'Project not found' };
  const remoteResult = await getRemoteUrl(project.path);
  if (remoteResult.isErr() || !remoteResult.value) {
    return { ok: false, status: 400, error: 'Could not determine remote URL' };
  }
  const parsed = parseGithubOwnerRepo(remoteResult.value);
  if (!parsed) return { ok: false, status: 400, error: 'Not a GitHub project' };
  const resolved = await resolveGithubToken(userId);
  if (!resolved) return { ok: false, status: 401, error: 'No GitHub token available' };
  return { ok: true, owner: parsed.owner, repo: parsed.repo, token: resolved.token };
}

/** The GitHub repository a project points at, with the caller's token for it. */
export interface GithubRepoAccess {
  owner: string;
  repo: string;
  token: string;
}

/**
 * The caller's GitHub access for a project, or the error response the route
 * returns as is (404 project not visible, 400 no GitHub remote, 401 no token).
 */
export async function githubRepoFor(
  c: Context<HonoEnv>,
  projectId: string,
): Promise<GithubRepoAccess | Response> {
  const ctx = await resolveGithubProjectContext(
    projectId,
    c.get('userId'),
    c.get('organizationId'),
  );
  if (!ctx.ok) return c.json({ error: ctx.error }, ctx.status);
  return { owner: ctx.owner, repo: ctx.repo, token: ctx.token };
}

/**
 * `githubRepoFor` for a PR route whose query carries `projectId` and
 * `prNumber`: 400 when either is missing, then the same answers.
 */
export async function githubPrFor(
  c: Context<HonoEnv>,
): Promise<(GithubRepoAccess & { prNumber: number }) | Response> {
  const projectId = c.req.query('projectId');
  const prNumber = positiveIntParam(c, 'prNumber');
  if (!projectId || !prNumber) {
    return c.json({ error: 'projectId and prNumber are required' }, 400);
  }
  const access = await githubRepoFor(c, projectId);
  return access instanceof Response ? access : { ...access, prNumber };
}

export interface ResolvedToken {
  token: string;
  source: 'profile' | 'cli';
}

/**
 * Resolve a GitHub token for the given user.
 *
 * 1. Check the user's profile in the database (encrypted provider key).
 * 2. Fall back to the local `gh auth token` CLI command.
 *
 * The CLI token is NOT persisted — it is resolved fresh each time.
 */
/** The caller's GitHub token, or the 401 saying they have not connected GitHub. */
export async function requireGithubToken(c: Context<HonoEnv>): Promise<string | Response> {
  const resolved = await resolveGithubToken(c.get('userId'));
  return resolved ? resolved.token : c.json({ error: 'Not connected to GitHub' }, 401);
}

export async function resolveGithubToken(userId: string): Promise<ResolvedToken | null> {
  const profileToken = await getServices().profile.getGithubToken(userId);
  if (profileToken) {
    return { token: profileToken, source: 'profile' };
  }

  try {
    const result = await execute('gh', ['auth', 'token'], {
      timeout: 5_000,
      reject: false,
      skipPool: true,
    });
    const cliToken = result.stdout.trim();
    if (result.exitCode === 0 && cliToken) {
      return { token: cliToken, source: 'cli' };
    }
  } catch {
    // gh not installed or other error — ignore
  }

  return null;
}
