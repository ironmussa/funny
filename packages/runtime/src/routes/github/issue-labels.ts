/**
 * POST /issues-labels: adds labels to several issues of a project's
 * repository, with the caller's GitHub token. GitHub makes a label the
 * repository does not have yet. The Issues tab uses it to put a lane label
 * (`lane:<name>`, openspec factory-lanes D1) on issues before it sends them to
 * the factory. An issue GitHub refuses is reported with GitHub's message and
 * the others are still labelled. The whole request is recorded as one
 * `github.write` activity.
 */
import {
  MAX_ISSUES_PER_LABEL,
  MAX_LABELS_PER_ADD,
  type AddIssueLabelsResult,
} from '@funny/shared/contracts/github-issues';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { recordedGithubWrite } from '../../services/github-write-activity.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { parseJsonBody } from '../../validation/request.js';
import { githubApiFetch, githubRepoFor } from './helpers.js';

export const issueLabelsRoutes = new Hono<HonoEnv>();

const addLabelsBodySchema = z.object({
  projectId: z.string().min(1),
  issueNumbers: z.array(z.number().int().positive()).min(1).max(MAX_ISSUES_PER_LABEL),
  // GitHub's limit on a label's name is 50 characters.
  labels: z.array(z.string().trim().min(1).max(50)).min(1).max(MAX_LABELS_PER_ADD),
});

/** GitHub's error body: only its message is shown. */
const githubErrorSchema = z.object({ message: z.string() });

type Repo = { owner: string; repo: string; token: string };

async function labelOneIssue(repo: Repo, issueNumber: number, labels: string[]) {
  try {
    const res = await githubApiFetch(
      `/repos/${repo.owner}/${repo.repo}/issues/${issueNumber}/labels`,
      repo.token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ labels }),
      },
    );
    if (res.ok) return null;
    const body = githubErrorSchema.safeParse(await res.json().catch(() => null));
    const message = body.success ? body.data.message : `HTTP ${res.status}`;
    return `#${issueNumber}: ${message}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** One at a time: GitHub counts writes against a secondary rate limit. */
async function labelIssues(
  c: Context<HonoEnv>,
  repo: Repo,
  issueNumbers: number[],
  labels: string[],
): Promise<Response> {
  const result: AddIssueLabelsResult = { labeled: [], failed: [] };
  for (const issueNumber of issueNumbers) {
    const message = await labelOneIssue(repo, issueNumber, labels);
    if (message === null) result.labeled.push(issueNumber);
    else result.failed.push({ issueNumber, message });
  }
  if (result.labeled.length === 0) {
    return c.json({ ...result, error: result.failed[0]?.message ?? 'No issue was labeled' }, 502);
  }
  return c.json(result);
}

issueLabelsRoutes.post('/issues-labels', async (c) => {
  const parsed = await parseJsonBody(c, addLabelsBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const { projectId, issueNumbers } = parsed.value;
  const unique = [...new Set(issueNumbers)];
  const labels = [...new Set(parsed.value.labels)];

  const repo = await githubRepoFor(c, projectId);
  if (repo instanceof Response) return repo;
  const fullName = `${repo.owner}/${repo.repo}`;

  return recordedGithubWrite(
    {
      userId: c.get('userId'),
      projectId,
      title:
        unique.length === 1
          ? `Label issue #${unique[0]} ${labels.join(', ')}`
          : `Label ${unique.length} issues ${labels.join(', ')}`,
      input: { action: 'issue-label', repo: fullName },
      effectsOf: (body) =>
        Array.isArray(body.labeled)
          ? body.labeled.map((n) => ({ effect: 'issue-labeled' as const, target: `#${n}` }))
          : [],
    },
    () => labelIssues(c, repo, unique, labels),
  );
});
