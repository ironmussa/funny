import { getRemoteUrl } from '@funny/core/git';
import type { PRFile, PRCommit } from '@funny/shared';
import { Hono } from 'hono';
import { z } from 'zod';

import { getServices } from '../../services/service-registry.js';
import type { HonoEnv } from '../../types/hono-env.js';
import { parseJsonBody } from '../../validation/request.js';
import { GITHUB_API, githubApiFetch, parseGithubOwnerRepo, resolveGithubToken } from './helpers.js';

export const prFileRoutes = new Hono<HonoEnv>();

const prRevertFileBodySchema = z
  .object({
    projectId: z.string().optional(),
    prNumber: z.union([z.number(), z.string()]).optional(),
    filePath: z.string().optional(),
  })
  .passthrough();

// ── PR Files (changed files in a pull request) ────────────────

prFileRoutes.get('/pr-files', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.query('projectId');
  const prNumber = Number(c.req.query('prNumber'));
  const commitSha = c.req.query('commitSha') || undefined;
  if (!projectId || !prNumber) {
    return c.json({ error: 'projectId and prNumber are required' }, 400);
  }

  const project = await getServices().projects.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const remoteResult = await getRemoteUrl(project.path);
  if (remoteResult.isErr() || !remoteResult.value) {
    return c.json({ error: 'Could not determine remote URL' }, 400);
  }

  const parsed = parseGithubOwnerRepo(remoteResult.value);
  if (!parsed) return c.json({ error: 'Not a GitHub project' }, 400);

  const resolved = await resolveGithubToken(userId);
  if (!resolved) return c.json({ error: 'No GitHub token available' }, 401);

  const { owner, repo } = parsed;
  const { token } = resolved;

  try {
    // If a specific commit is requested, get the diff for that commit only
    if (commitSha) {
      const res = await githubApiFetch(`/repos/${owner}/${repo}/commits/${commitSha}`, token);
      if (!res.ok) {
        return c.json({ error: `GitHub API error: ${res.status}` }, 502);
      }
      const data = (await res.json()) as any;
      const files: PRFile[] = ((data.files as any[]) ?? []).map((f: any) => ({
        sha: f.sha ?? '',
        filename: f.filename ?? '',
        status: f.status ?? 'modified',
        additions: f.additions ?? 0,
        deletions: f.deletions ?? 0,
        changes: f.changes ?? 0,
        patch: f.patch,
        previous_filename: f.previous_filename,
      }));
      return c.json({ files });
    }

    // Otherwise, get all changed files across the entire PR (paginated)
    const allFiles: PRFile[] = [];
    let page = 1;
    while (true) {
      const res = await githubApiFetch(
        `/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`,
        token,
      );
      if (!res.ok) {
        return c.json({ error: `GitHub API error: ${res.status}` }, 502);
      }
      const data = (await res.json()) as any[];
      if (data.length === 0) break;

      for (const f of data) {
        allFiles.push({
          sha: f.sha ?? '',
          filename: f.filename ?? '',
          status: f.status ?? 'modified',
          additions: f.additions ?? 0,
          deletions: f.deletions ?? 0,
          changes: f.changes ?? 0,
          patch: f.patch,
          previous_filename: f.previous_filename,
        });
      }

      if (data.length < 100) break;
      page++;
    }

    return c.json({ files: allFiles });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── PR Commits (list commits in a pull request) ───────────────

prFileRoutes.get('/pr-commits', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.query('projectId');
  const prNumber = Number(c.req.query('prNumber'));
  if (!projectId || !prNumber) {
    return c.json({ error: 'projectId and prNumber are required' }, 400);
  }

  const project = await getServices().projects.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const remoteResult = await getRemoteUrl(project.path);
  if (remoteResult.isErr() || !remoteResult.value) {
    return c.json({ error: 'Could not determine remote URL' }, 400);
  }

  const parsed = parseGithubOwnerRepo(remoteResult.value);
  if (!parsed) return c.json({ error: 'Not a GitHub project' }, 400);

  const resolved = await resolveGithubToken(userId);
  if (!resolved) return c.json({ error: 'No GitHub token available' }, 401);

  const { owner, repo } = parsed;
  const { token } = resolved;

  try {
    const allCommits: PRCommit[] = [];
    let page = 1;
    while (true) {
      const res = await githubApiFetch(
        `/repos/${owner}/${repo}/pulls/${prNumber}/commits?per_page=100&page=${page}`,
        token,
      );
      if (!res.ok) {
        return c.json({ error: `GitHub API error: ${res.status}` }, 502);
      }
      const data = (await res.json()) as any[];
      if (data.length === 0) break;

      for (const c of data) {
        allCommits.push({
          sha: c.sha ?? '',
          message: c.commit?.message ?? '',
          author: c.author ? { login: c.author.login, avatar_url: c.author.avatar_url } : null,
          date: c.commit?.committer?.date ?? c.commit?.author?.date ?? '',
        });
      }

      if (data.length < 100) break;
      page++;
    }

    return c.json({ commits: allCommits });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});

// ── Commit Authors (avatar_url per SHA for commit history view) ──────

prFileRoutes.get('/commit-authors', async (c) => {
  const userId = c.get('userId') as string;
  const projectId = c.req.query('projectId');
  if (!projectId) return c.json({ error: 'projectId is required' }, 400);

  const project = await getServices().projects.getProject(projectId);
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
  const perPage = Math.min(Number(c.req.query('per_page')) || 100, 100);
  const page = Number(c.req.query('page')) || 1;

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
  const userId = c.get('userId') as string;
  const projectId = c.req.query('projectId');
  const prNumber = Number(c.req.query('prNumber'));
  const filePath = c.req.query('filePath');
  if (!projectId || !prNumber || !filePath) {
    return c.json({ error: 'projectId, prNumber, and filePath are required' }, 400);
  }

  const project = await getServices().projects.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const remoteResult = await getRemoteUrl(project.path);
  if (remoteResult.isErr() || !remoteResult.value) {
    return c.json({ error: 'Could not determine remote URL' }, 400);
  }

  const parsed = parseGithubOwnerRepo(remoteResult.value);
  if (!parsed) return c.json({ error: 'Not a GitHub project' }, 400);

  const resolved = await resolveGithubToken(userId);
  if (!resolved) return c.json({ error: 'No GitHub token available' }, 401);

  const { owner, repo } = parsed;
  const { token } = resolved;

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
  const userId = c.get('userId') as string;
  const parsed = await parseJsonBody(c, prRevertFileBodySchema);
  if (parsed.isErr()) return c.json({ error: parsed.error.message }, 400);
  const body = parsed.value;
  const { projectId, prNumber, filePath } = body;
  if (!projectId || !prNumber || !filePath) {
    return c.json({ error: 'projectId, prNumber, and filePath are required' }, 400);
  }

  const project = await getServices().projects.getProject(projectId);
  if (!project) return c.json({ error: 'Project not found' }, 404);

  const remoteResult = await getRemoteUrl(project.path);
  if (remoteResult.isErr() || !remoteResult.value) {
    return c.json({ error: 'Could not determine remote URL' }, 400);
  }

  const ownerRepo = parseGithubOwnerRepo(remoteResult.value);
  if (!ownerRepo) return c.json({ error: 'Not a GitHub project' }, 400);

  const resolved = await resolveGithubToken(userId);
  if (!resolved) return c.json({ error: 'No GitHub token available' }, 401);

  const { owner, repo } = ownerRepo;
  const { token } = resolved;

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

    if (baseFileRes.status === 404) {
      // File doesn't exist in base branch — it was added in the PR.
      // To "revert" means to delete it from the head branch.
      // First get the file's SHA on the head branch
      const headFileRes = await githubApiFetch(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${headRef}`,
        token,
      );
      if (!headFileRes.ok) {
        return c.json({ error: 'File not found on head branch' }, 404);
      }
      const headFileData = (await headFileRes.json()) as any;

      const deleteRes = await githubApiFetch(
        `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`,
        token,
        {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `revert: remove ${filePath} (not in base branch)`,
            sha: headFileData.sha,
            branch: headRef,
          }),
        },
      );
      if (!deleteRes.ok) {
        const errBody = (await deleteRes.json().catch(() => ({}))) as any;
        return c.json(
          { error: errBody.message || `Failed to delete file: ${deleteRes.status}` },
          502,
        );
      }
      return c.json({ ok: true, action: 'deleted' });
    }

    if (!baseFileRes.ok) {
      return c.json({ error: `Failed to fetch base file: ${baseFileRes.status}` }, 502);
    }
    const baseFileData = (await baseFileRes.json()) as any;
    const baseContent = baseFileData.content; // base64-encoded

    // 3. Get the current file SHA on the head branch (required for update)
    const headFileRes = await githubApiFetch(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}?ref=${headRef}`,
      token,
    );
    if (!headFileRes.ok) {
      return c.json({ error: `Failed to fetch head file: ${headFileRes.status}` }, 502);
    }
    const headFileData = (await headFileRes.json()) as any;

    // 4. Update the file on the head branch with the base content
    const updateRes = await githubApiFetch(
      `/repos/${owner}/${repo}/contents/${encodeURIComponent(filePath)}`,
      token,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: `revert: restore ${filePath} to ${baseRef}`,
          content: baseContent,
          sha: headFileData.sha,
          branch: headRef,
        }),
      },
    );

    if (!updateRes.ok) {
      const errBody = (await updateRes.json().catch(() => ({}))) as any;
      return c.json(
        { error: errBody.message || `Failed to update file: ${updateRes.status}` },
        502,
      );
    }

    return c.json({ ok: true, action: 'reverted' });
  } catch (error: any) {
    return c.json({ error: error.message }, 502);
  }
});
