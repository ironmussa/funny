/**
 * @domain subdomain: External Integration
 * @domain subdomain-type: supporting
 * @domain type: domain-service
 * @domain layer: infrastructure
 * @domain depends: ProjectManager
 *
 * Resolves which project an external ingest event belongs to, from a working
 * path or a GitHub owner/repo. Split out of ingest-mapper.ts.
 */

import { getRemoteUrl, getWorktreeBasePaths } from '@funny/core/git';

import { parseGithubOwnerRepo } from '../lib/github-remote.js';
import { getServices } from './service-registry.js';

/** True when the (normalised, lowercase) path is inside one of the project's worktree bases. */
function isInWorktreeBase(normalisedPath: string, projectPath: string): boolean {
  return getWorktreeBasePaths(projectPath).some((base) =>
    normalisedPath.startsWith(base.replace(/\\/g, '/').toLowerCase() + '/'),
  );
}

/**
 * Resolve a project from a worktree/working path by checking if any project's
 * path is a prefix of the given path.
 */
export async function resolveProjectId(workingPath: string): Promise<string | null> {
  const normalised = workingPath.replace(/\\/g, '/').toLowerCase();
  const projects = await getServices().projects.listProjects('');

  // First pass: exact prefix match (project path is prefix of working path).
  // Guard with a trailing '/' to prevent sibling-prefix matches like
  // `/a/foo` being identified as belonging to project `/a/fo`.
  for (const project of projects) {
    const projPath = project.path.replace(/\\/g, '/').toLowerCase();
    if (normalised === projPath || normalised.startsWith(projPath + '/')) {
      return project.id;
    }
  }

  // Second pass: inside one of the project's worktree bases (next to the
  // project, or under FUNNY_WORKTREE_ROOT where the folder name carries a hash).
  const byBase = projects.find((project) => isInWorktreeBase(normalised, project.path));
  if (byBase) return byBase.id;

  // Third pass: worktree match — extract the repo name from the worktree path
  // Worktree paths look like: .../.funny-worktrees/<repo-name>/<branch-slug>/...
  if (normalised.includes('.funny-worktrees')) {
    const wtIdx = normalised.indexOf('.funny-worktrees/');
    if (wtIdx !== -1) {
      const afterWt = normalised.slice(wtIdx + '.funny-worktrees/'.length);
      const repoName = afterWt.split('/')[0]?.toLowerCase();
      if (repoName) {
        for (const project of projects) {
          const projName = project.path.replace(/\\/g, '/').split('/').pop()?.toLowerCase();
          if (projName === repoName) {
            return project.id;
          }
        }
      }
    }
  }

  return null;
}

/** Extract owner/repo from a GitHub remote URL. */
export function parseOwnerRepo(remoteUrl: string): string | null {
  const parsed = parseGithubOwnerRepo(remoteUrl);
  return parsed ? `${parsed.owner}/${parsed.repo}` : null;
}

/**
 * Resolve a project by GitHub owner/repo (e.g. "acme/backend").
 * Scans all projects' git remotes asynchronously.
 */
export async function resolveProjectByRepo(repoFullName: string): Promise<string | null> {
  const target = repoFullName.toLowerCase();
  const projects = await getServices().projects.listProjects('');

  for (const project of projects) {
    const result = await getRemoteUrl(project.path);
    if (result.isErr() || !result.value) continue;
    const ownerRepo = parseOwnerRepo(result.value);
    if (ownerRepo && ownerRepo.toLowerCase() === target) {
      return project.id;
    }
  }
  return null;
}
