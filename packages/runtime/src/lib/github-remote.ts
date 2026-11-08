/**
 * HTTPS (`https://github.com/owner/repo.git`), SSH (`git@github.com:owner/repo`)
 * and `ssh://` remotes. Repo names may contain dots (`user.github.io`,
 * `lodash.js`); only a trailing `.git` and `/` are stripped.
 */
const GITHUB_REMOTE_RE = /(?:^|[@/])github\.com[/:]([\w-]+)\/([\w.-]+?)(?:\.git)?\/?$/;

/** Extract owner/repo from a GitHub remote URL. Returns null if not a GitHub URL. */
export function parseGithubOwnerRepo(remoteUrl: string): { owner: string; repo: string } | null {
  const match = remoteUrl.trim().match(GITHUB_REMOTE_RE);
  return match ? { owner: match[1], repo: match[2] } : null;
}
