/**
 * The checks every project-scoped GitHub list route (issues, PRs, PR search)
 * runs before it calls GitHub, in this order: the project id, access to the
 * project (404 before any git or GitHub call), its GitHub remote, then the
 * `state`, paging and cursor query parameters.
 */

import { getRemoteUrl } from '@funny/core/git';
import type { Context } from 'hono';

import type { HonoEnv } from '../../types/hono-env.js';
import { parseGithubOwnerRepo, requireAccessibleProject } from './helpers.js';
import { readCursor, readIssueState, readPaging } from './query.js';

export interface GithubListContext {
  userId: string;
  projectPath: string;
  owner: string;
  repo: string;
  state: 'open' | 'closed' | 'all';
  page: number;
  perPage: number;
  /** GraphQL page cursor from the previous page; `null` for page 1. */
  cursor: string | null;
}

type ListContextResult = { ok: true; ctx: GithubListContext } | { ok: false; response: Response };

const fail = (c: Context<HonoEnv>, error: string, status: 400 | 404): ListContextResult => ({
  ok: false,
  response: c.json({ error }, status),
});

export async function readGithubListContext(c: Context<HonoEnv>): Promise<ListContextResult> {
  const userId = c.get('userId') as string;
  const projectId = c.req.query('projectId');
  if (!projectId) return fail(c, 'projectId is required', 400);

  const project = await requireAccessibleProject(projectId, userId, c.get('organizationId'));
  if (!project) return fail(c, 'Project not found', 404);

  const remoteResult = await getRemoteUrl(project.path);
  if (remoteResult.isErr() || !remoteResult.value) {
    return fail(c, 'Could not determine remote URL for this project', 400);
  }
  const parsed = parseGithubOwnerRepo(remoteResult.value);
  if (!parsed) return fail(c, 'This project is not hosted on GitHub', 400);

  const stateResult = readIssueState(c);
  if (stateResult.isErr()) return fail(c, stateResult.error.message, 400);
  const cursorResult = readCursor(c);
  if (cursorResult.isErr()) return fail(c, cursorResult.error.message, 400);

  return {
    ok: true,
    ctx: {
      userId,
      projectPath: project.path,
      owner: parsed.owner,
      repo: parsed.repo,
      state: stateResult.value,
      ...readPaging(c, 30),
      cursor: cursorResult.value,
    },
  };
}
