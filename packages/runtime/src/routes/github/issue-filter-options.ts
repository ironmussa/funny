/**
 * What the Issues panel's filter dropdowns offer: the repository's labels,
 * assignable users (author and assignee pickers), open milestones, issue types
 * and linked projects.
 *
 * With a token, two GraphQL requests: projects need the `read:project` scope,
 * which many tokens lack, and GitHub refuses the whole query when one field is
 * out of scope, so projects go alone and a refusal leaves only them empty.
 * Without a token, the anonymous REST endpoints (public repos only) give
 * labels, users and milestones; types and projects stay empty.
 */

import type { GitHubUserRef, IssueFilterOptions } from '@funny/shared';

import { log } from '../../lib/logger.js';
import { GITHUB_API, githubGraphQL } from './helpers.js';

const REPO_OPTIONS_QUERY = `
  query IssueFilterOptions($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      labels(first: 100, orderBy: { field: NAME, direction: ASC }) { nodes { name color } }
      assignableUsers(first: 100) { nodes { login avatarUrl } }
      milestones(first: 50, states: OPEN, orderBy: { field: DUE_DATE, direction: ASC }) {
        nodes { title }
      }
      issueTypes(first: 25) { nodes { name color isEnabled } }
    }
  }
`;

const REPO_PROJECTS_QUERY = `
  query IssueFilterProjects($owner: String!, $repo: String!) {
    repository(owner: $owner, name: $repo) {
      projectsV2(first: 30, orderBy: { field: TITLE, direction: ASC }) {
        nodes {
          number
          title
          closed
          owner { ... on Organization { login } ... on User { login } }
        }
      }
    }
  }
`;

export interface RepoOptionsData {
  repository: {
    labels: { nodes: Array<{ name: string; color: string }> } | null;
    assignableUsers: { nodes: Array<{ login: string; avatarUrl: string }> } | null;
    milestones: { nodes: Array<{ title: string }> } | null;
    issueTypes: { nodes: Array<{ name: string; color: string; isEnabled: boolean }> } | null;
  } | null;
}

export interface RepoProjectsData {
  repository: {
    projectsV2: {
      nodes: Array<{
        number: number;
        title: string;
        closed: boolean;
        owner: { login?: string } | null;
      } | null>;
    } | null;
  } | null;
}

/** Maps both GraphQL responses (projects may be missing) to the options the client reads. */
export function mapIssueFilterOptions(
  repoData: RepoOptionsData,
  projectsData: RepoProjectsData | null,
): IssueFilterOptions {
  const r = repoData.repository;
  const projects: IssueFilterOptions['projects'] = [];
  for (const p of projectsData?.repository?.projectsV2?.nodes ?? []) {
    if (!p || p.closed || !p.owner?.login) continue;
    projects.push({ owner: p.owner.login, number: p.number, title: p.title });
  }
  return {
    labels: r?.labels?.nodes ?? [],
    users: (r?.assignableUsers?.nodes ?? []).map((u) => ({
      login: u.login,
      avatar_url: u.avatarUrl,
    })),
    milestones: r?.milestones?.nodes ?? [],
    types: (r?.issueTypes?.nodes ?? [])
      .filter((t) => t.isEnabled)
      .map((t) => ({ name: t.name, color: t.color })),
    projects,
  };
}

async function anonymousJson<T>(path: string): Promise<T | null> {
  const res = await fetch(`${GITHUB_API}${path}`, {
    headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  // SAFETY: GitHub's REST list responses; the callers read only the fields they map.
  return res.ok ? ((await res.json()) as T) : null;
}

async function anonymousOptions(owner: string, repo: string): Promise<IssueFilterOptions> {
  const base = `/repos/${owner}/${repo}`;
  const [labels, users, milestones] = await Promise.all([
    anonymousJson<Array<{ name: string; color: string }>>(`${base}/labels?per_page=100`),
    anonymousJson<Array<{ login: string; avatar_url: string }>>(`${base}/assignees?per_page=100`),
    anonymousJson<Array<{ title: string }>>(`${base}/milestones?state=open&per_page=50`),
  ]);
  return {
    labels: (labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    users: (users ?? []).map((u): GitHubUserRef => ({ login: u.login, avatar_url: u.avatar_url })),
    milestones: (milestones ?? []).map((m) => ({ title: m.title })),
    types: [],
    projects: [],
  };
}

export async function fetchIssueFilterOptions(
  owner: string,
  repo: string,
  token: string | null,
): Promise<IssueFilterOptions> {
  if (!token) return anonymousOptions(owner, repo);
  const [repoData, projectsData] = await Promise.all([
    githubGraphQL<RepoOptionsData>(REPO_OPTIONS_QUERY, { owner, repo }, token),
    githubGraphQL<RepoProjectsData>(REPO_PROJECTS_QUERY, { owner, repo }, token).catch(
      (error: Error) => {
        // Usually a token without `read:project`: the Projects filter stays empty.
        log.info('issue filter projects unavailable', {
          namespace: 'github-issues',
          repo: `${owner}/${repo}`,
          error: error?.message,
        });
        return null;
      },
    ),
  ]);
  return mapIssueFilterOptions(repoData, projectsData);
}
