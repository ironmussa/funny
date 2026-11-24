/**
 * POST /issues-delete: deletes several issues of a project's repository for
 * good, with the caller's GitHub token. GitHub only lets a repository admin
 * delete an issue (GraphQL `deleteIssue`); an issue it refuses is reported
 * with GitHub's message and the others are still deleted. The whole send is
 * recorded as one `github.write` activity.
 */
import {
  MAX_ISSUES_PER_DELETE,
  type DeleteIssuesResult,
} from '@funny/shared/contracts/github-issues';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { recordedGithubWrite } from '../../services/github-write-activity.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { parseJsonBody } from '../../validation/request.js';
import { githubGraphQL, githubRepoFor } from './helpers.js';

export const issueDeleteRoutes = new Hono<HonoEnv>();

const deleteIssuesBodySchema = z.object({
  projectId: z.string().min(1),
  issueNumbers: z.array(z.number().int().positive()).min(1).max(MAX_ISSUES_PER_DELETE),
});

const ISSUE_ID_QUERY = `query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) { issue(number: $number) { id } }
}`;

const DELETE_ISSUE_MUTATION = `mutation($id: ID!) {
  deleteIssue(input: { issueId: $id }) { clientMutationId }
}`;

async function deleteOneIssue(
  repo: { owner: string; repo: string; token: string },
  issueNumber: number,
): Promise<string | null> {
  try {
    const found = await githubGraphQL<{ repository: { issue: { id: string } | null } | null }>(
      ISSUE_ID_QUERY,
      { owner: repo.owner, repo: repo.repo, number: issueNumber },
      repo.token,
    );
    const id = found.repository?.issue?.id;
    if (!id) return `Issue #${issueNumber} was not found`;
    await githubGraphQL(DELETE_ISSUE_MUTATION, { id }, repo.token);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** One at a time: GitHub counts mutations against a secondary rate limit. */
async function deleteIssues(
  c: Context<HonoEnv>,
  repo: { owner: string; repo: string; token: string },
  issueNumbers: number[],
): Promise<Response> {
  const result: DeleteIssuesResult = { deleted: [], failed: [] };
  for (const issueNumber of issueNumbers) {
    const message = await deleteOneIssue(repo, issueNumber);
    if (message === null) result.deleted.push(issueNumber);
    else result.failed.push({ issueNumber, message });
  }
  if (result.deleted.length === 0) {
    return c.json({ ...result, error: result.failed[0]?.message ?? 'No issue was deleted' }, 502);
  }
  return c.json(result);
}

issueDeleteRoutes.post('/issues-delete', async (c) => {
  const parsed = await parseJsonBody(c, deleteIssuesBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const { projectId, issueNumbers } = parsed.value;
  const unique = [...new Set(issueNumbers)];

  const repo = await githubRepoFor(c, projectId);
  if (repo instanceof Response) return repo;
  const fullName = `${repo.owner}/${repo.repo}`;

  return recordedGithubWrite(
    {
      userId: c.get('userId'),
      projectId,
      title: unique.length === 1 ? `Delete issue #${unique[0]}` : `Delete ${unique.length} issues`,
      input: { action: 'issue-delete', repo: fullName },
      effectsOf: (body) =>
        Array.isArray(body.deleted)
          ? body.deleted.map((n) => ({ effect: 'issue-deleted' as const, target: `#${n}` }))
          : [],
    },
    () => deleteIssues(c, repo, unique),
  );
});
