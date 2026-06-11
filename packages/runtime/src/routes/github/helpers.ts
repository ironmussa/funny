import { execute, getRemoteUrl } from '@funny/core/git';
import type { GitHubIssue, PRReactionSummary } from '@funny/shared';

import { getServices } from '../../services/service-registry.js';

export const GITHUB_API = 'https://api.github.com';
export const DEVICE_CODE_URL = 'https://github.com/login/device/code';
export const ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token';

export function getClientId(): string | null {
  return process.env.GITHUB_CLIENT_ID || null;
}

/** Extract owner/repo from a GitHub remote URL. Returns null if not a GitHub URL. */
export function parseGithubOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  // HTTPS: https://github.com/owner/repo.git
  const httpsMatch = remoteUrl.match(/github\.com[/:]([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (httpsMatch) return { owner: httpsMatch[1], repo: httpsMatch[2] };
  // SSH: git@github.com:owner/repo.git
  const sshMatch = remoteUrl.match(/git@github\.com:([^/]+)\/([^/.]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  return null;
}

/** Make an authenticated request to the GitHub API. */
export async function githubApiFetch(
  path: string,
  token: string,
  init?: RequestInit,
): Promise<Response> {
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

/** Run a GitHub GraphQL query. Returns parsed `data` or throws. */
export async function githubGraphQL<T = any>(
  query: string,
  variables: Record<string, unknown>,
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
  const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (body.errors?.length) throw new Error(body.errors.map((e) => e.message).join('; '));
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
  opts: { state: string; page: number; perPage: number; token: string | null },
): Promise<{ issues: GitHubIssue[]; hasMore: boolean } | null> {
  const { state, page, perPage, token } = opts;
  // `state` accepts open|closed|all — only constrain the query when it is a
  // concrete state, mirroring the GitHub Search qualifier syntax.
  const stateQualifier = state === 'open' || state === 'closed' ? ` state:${state}` : '';
  const q = encodeURIComponent(`repo:${owner}/${repo} type:issue${stateQualifier}`);
  const apiPath = `/search/issues?q=${q}&sort=created&order=desc&page=${page}&per_page=${perPage}`;

  const res = token
    ? await githubApiFetch(apiPath, token)
    : await fetch(`${GITHUB_API}${apiPath}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
      });
  if (!res.ok) return null;

  const body = (await res.json()) as { total_count: number; items: GitHubIssue[] };
  const items = Array.isArray(body.items) ? body.items : [];
  // Defensive: type:issue should already exclude PRs, but keep the guard.
  const issues = items.filter((i) => !i.pull_request);
  const hasMore = page * perPage < (body.total_count ?? 0);
  return { issues, hasMore };
}

export function emptyReactions(): PRReactionSummary {
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

/** Resolve a GitHub project context: parse remote, token, owner/repo. */
export async function resolveGithubProjectContext(
  projectId: string,
  userId: string,
): Promise<
  | { ok: true; owner: string; repo: string; token: string }
  | { ok: false; status: number; error: string }
> {
  const project = await getServices().projects.getProject(projectId);
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
