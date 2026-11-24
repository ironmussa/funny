import { getRemoteUrl } from '@funny/core/git';
import type { PRFile, PRCommit } from '@funny/shared';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { isString } from '../../lib/value-guards.js';
import { recordedGithubWrite } from '../../services/github-write-activity.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { parseJsonBody } from '../../validation/request.js';
import {
  GITHUB_API,
  fetchAllPages,
  githubApiFetch,
  githubPrFor,
  githubRepoFor,
  parseGithubOwnerRepo,
  requireAccessibleProject,
  resolveGithubToken,
} from './helpers.js';
import { positiveIntParam, readPaging } from './query.js';

export const prFileRoutes = new Hono<HonoEnv>();

/** A changed file as GitHub's PR files / commit endpoints report it. */
function mapPrFile(f: any): PRFile {
  return {
    sha: f.sha ?? '',
    filename: f.filename ?? '',
    status: f.status ?? 'modified',
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    changes: f.changes ?? 0,
    patch: f.patch,
    previous_filename: f.previous_filename,
  };
}

const prRevertFileBodySchema = z
  .object({
    projectId: z.string().optional(),
    prNumber: z.union([z.number(), z.string()]).optional(),
    filePath: z.string().optional(),
  })
  .passthrough();

// ── PR Files (changed files in a pull request) ────────────────

prFileRoutes.get('/pr-files', async (c) => {
  const commitSha = c.req.query('commitSha') || undefined;
  const access = await githubPrFor(c);
  if (access instanceof Response) return access;
  const { owner, repo, token, prNumber } = access;

  try {
    // If a specific commit is requested, get the diff for that commit only
    if (commitSha) {
      const res = await githubApiFetch(`/repos/${owner}/${repo}/commits/${commitSha}`, token);
      if (!res.ok) {
        return c.json({ error: `GitHub API error: ${res.status}` }, 502);
      }
      const data = (await res.json()) as any;
      return c.json({ files: ((data.files as any[]) ?? []).map(mapPrFile) });
    }

    // Otherwise, get all changed files across the entire PR (paginated)
    const pages = await fetchAllPages(`/repos/${owner}/${repo}/pulls/${prNumber}/files`, token);
    if (!pages.ok) return c.json({ error: `GitHub API error: ${pages.status}` }, 502);
    return c.json({ files: pages.items.map(mapPrFile) });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── PR Commits (list commits in a pull request) ───────────────

prFileRoutes.get('/pr-commits', async (c) => {
  const access = await githubPrFor(c);
  if (access instanceof Response) return access;
  const { owner, repo, token, prNumber } = access;

  try {
    const pages = await fetchAllPages(`/repos/${owner}/${repo}/pulls/${prNumber}/commits`, token);
    if (!pages.ok) return c.json({ error: `GitHub API error: ${pages.status}` }, 502);
    const commits: PRCommit[] = pages.items.map((cm) => ({
      sha: cm.sha ?? '',
      message: cm.commit?.message ?? '',
      author: cm.author ? { login: cm.author.login, avatar_url: cm.author.avatar_url } : null,
      date: cm.commit?.committer?.date ?? cm.commit?.author?.date ?? '',
    }));
    return c.json({ commits });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── Commit Authors (avatar_url per SHA for commit history view) ──────

prFileRoutes.get('/commit-authors', async (c) => {
  const userId = c.get('userId');
  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId is required' }, 400);

  const project = await requireAccessibleProject(projectId, userId, c.get('organizationId'));
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const remoteResult = await getRemoteUrl(project.path);
  if (remoteResult.isErr() || !remoteResult.value) {
    return c.json({ authors: [] });
  }
  const parsed = parseGithubOwnerRepo(remoteResult.value);
  if (!parsed) return c.json({ authors: [] });

  const resolved = await resolveGithubToken(userId);
  const token = resolved?.token ?? null;

  const sha = c.req.query('sha') || undefined;
  const { page, perPage } = readPaging(c, 100);

  const qs = new URLSearchParams({ per_page: String(perPage), page: String(page) });
  if (sha) qs.set('sha', sha);
  const apiPath = `/repos/${parsed.owner}/${parsed.repo}/commits?${qs.toString()}`;

  try {
    const res = token
      ? await githubApiFetch(apiPath, token)
      : await fetch(`${GITHUB_API}${apiPath}`, {
          headers: {
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        });
    if (!res.ok) return c.json({ authors: [] });
    const data = (await res.json()) as any[];
    const authors = data
      .map((c: any) => ({
        sha: c.sha as string,
        login: (c.author?.login as string) ?? null,
        avatar_url: (c.author?.avatar_url as string) ?? null,
      }))
      .filter((a) => a.sha && a.avatar_url);
    return c.json({ authors });
  } catch {
    return c.json({ authors: [] });
  }
});

// ── PR File Content (get full file content from base and head branches) ──────

prFileRoutes.get('/pr-file-content', async (c) => {
  const projectId = c.req.query('projectId');
  const prNumber = positiveIntParam(c, 'prNumber');
  const filePath = c.req.query('filePath');
  if (!projectId || !prNumber || !filePath) {
    return c.json({ error: 'projectId, prNumber, and filePath are required' }, 400);
  }

  const access = await githubRepoFor(c, projectId);
  if (access instanceof Response) return access;
  const { owner, repo, token } = access;

  try {
    const prRes = await githubApiFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, token);
    if (!prRes.ok) {
      return c.json({ error: `Failed to fetch PR: ${prRes.status}` }, 502);
    }
    const prData = (await prRes.json()) as any;
    const baseRef = prData.base?.ref;
    const headRef = prData.head?.ref;

    // Fetch both base and head versions in parallel
    const encodedPath = encodeURIComponent(filePath);
    const [baseRes, headRes] = await Promise.all([
      githubApiFetch(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${baseRef}`, token, {
        headers: { Accept: 'application/vnd.github.raw+json' },
      }),
      githubApiFetch(`/repos/${owner}/${repo}/contents/${encodedPath}?ref=${headRef}`, token, {
        headers: { Accept: 'application/vnd.github.raw+json' },
      }),
    ]);

    const baseContent = baseRes.ok ? await baseRes.text() : '';
    const headContent = headRes.ok ? await headRes.text() : '';

    return c.json({ baseContent, headContent });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── PR Revert File (revert a file to its base branch state) ──────

prFileRoutes.post('/pr-revert-file', async (c) => {
  const parsed = await parseJsonBody(c, prRevertFileBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const body = parsed.value;
  const { projectId, prNumber, filePath } = body;
  if (!projectId || !prNumber || !filePath) {
    return c.json({ error: 'projectId, prNumber, and filePath are required' }, 400);
  }

  const access = await githubRepoFor(c, projectId);
  if (access instanceof Response) return access;
  const { owner, repo, token } = access;

  // Recorded as a `github.write` activity (track-user-and-scheduled-actions).
  return recordedGithubWrite(
    {
      userId: c.get('userId'),
      projectId,
      title: `Revert ${filePath} in ${owner}/${repo}#${prNumber}`,
      input: {
        action: 'pr-revert-file',
        prNumber: Number(prNumber),
        filePath,
        repo: `${owner}/${repo}`,
      },
      effectsOf: () => [{ effect: 'file-reverted', target: filePath }],
      resultRefOf: () => ({ prUrl: `https://github.com/${owner}/${repo}/pull/${prNumber}` }),
    },
    () => revertPullRequestFile(c, { owner, repo, token, prNumber, filePath }),
  );
});

async function revertPullRequestFile(
  c: Context<HonoEnv>,
  args: { owner: string; repo: string; token: string; prNumber: number | string; filePath: string },
): Promise<Response> {
  const { owner, repo, token, prNumber, filePath } = args;
  try {
    // 1. Get the PR to know the base and head branches
    const prRes = await githubApiFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, token);
    if (!prRes.ok) {
      return c.json({ error: `Failed to fetch PR: ${prRes.status}` }, 502);
    }
    const prData = (await prRes.json()) as any;
    const baseRef = prData.base?.ref;
    const headRef = prData.head?.ref;
    if (!baseRef || !headRef) {
      return c.json({ error: 'Could not determine PR branches' }, 400);
    }

    // 2. Get the file content from the base branch
    const baseFileRes = await githubApiFetch(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${baseRef}`,
      token,
    );

    // A file the base branch does not have was added in the PR: reverting
    // deletes it from the head branch. Otherwise it gets the base version.
    const file = { owner, repo, token, filePath, headRef };
    if (baseFileRes.status === 404) return deleteAddedFile(c, file);
    if (!baseFileRes.ok) {
      return c.json({ error: `Failed to fetch base file: ${baseFileRes.status}` }, 502);
    }
    const baseFileData = (await baseFileRes.json()) as any;
    return restoreBaseFile(c, file, baseRef, baseFileData.content);
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
}

interface PullRequestFile {
  owner: string;
  repo: string;
  token: string;
  filePath: string;
  headRef: string;
}

/** The file's blob sha on the head branch (GitHub needs it to change the file), or a response. */
async function headFileSha(c: Context<HonoEnv>, f: PullRequestFile): Promise<string | Response> {
  const res = await githubApiFetch(
    `/repos/${f.owner}/${f.repo}/contents/${encodeURIComponent(f.filePath)}?ref=${f.headRef}`,
    f.token,
  );
  if (res.status === 404) return c.json({ error: 'File not found on head branch' }, 404);
  if (!res.ok) return c.json({ error: `Failed to fetch head file: ${res.status}` }, 502);
  return ((await res.json()) as any).sha;
}

/** Write the file on the head branch (`method` PUT to update, DELETE to remove). */
async function writeHeadFile(
  c: Context<HonoEnv>,
  f: PullRequestFile,
  method: 'PUT' | 'DELETE',
  body: Record<string, unknown>,
  action: 'deleted' | 'reverted',
): Promise<Response> {
  const sha = await headFileSha(c, f);
  if (!isString(sha)) return sha;
  const res = await githubApiFetch(
    `/repos/${f.owner}/${f.repo}/contents/${encodeURIComponent(f.filePath)}`,
    f.token,
    {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, sha, branch: f.headRef }),
    },
  );
  if (!res.ok) {
    const errBody = (await res.json().catch(() => ({}))) as any;
    const verb = method === 'DELETE' ? 'delete' : 'update';
    return c.json({ error: errBody.message || `Failed to ${verb} file: ${res.status}` }, 502);
  }
  return c.json({ ok: true, action });
}

function deleteAddedFile(c: Context<HonoEnv>, f: PullRequestFile): Promise<Response> {
  return writeHeadFile(
    c,
    f,
    'DELETE',
    { message: `revert: remove ${f.filePath} (not in base branch)` },
    'deleted',
  );
}

function restoreBaseFile(
  c: Context<HonoEnv>,
  f: PullRequestFile,
  baseRef: string,
  content: string,
): Promise<Response> {
  return writeHeadFile(
    c,
    f,
    'PUT',
    { message: `revert: restore ${f.filePath} to ${baseRef}`, content },
    'reverted',
  );
}
