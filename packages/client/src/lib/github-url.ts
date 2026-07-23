import { remoteUrlToBrowseUrl } from '@/lib/git-remote-url';

/** HTTPS GitHub repo root from a git remote URL, or null if not GitHub. */
export function githubBrowseBaseUrl(remoteUrl: string | null | undefined): string | null {
  if (!remoteUrl || remoteUrl === 'exists') return null;
  const browse = remoteUrlToBrowseUrl(remoteUrl);
  if (!browse?.includes('github.com')) return null;
  return browse.replace(/\/$/, '');
}

export function githubCommitUrl(browseBaseUrl: string, hash: string): string {
  return `${browseBaseUrl.replace(/\/$/, '')}/commit/${hash}`;
}

/** GitHub branch page URL. Each path segment is encoded while preserving branch slashes. */
export function githubBranchUrl(browseBaseUrl: string, branch: string): string {
  const encodedBranch = branch.split('/').map(encodeURIComponent).join('/');
  return `${browseBaseUrl.replace(/\/$/, '')}/tree/${encodedBranch}`;
}

export function githubCommitUrlForRemoteCommit(
  browseBaseUrl: string | null,
  hash: string,
  isLocalOnly: boolean,
): string | null {
  if (!browseBaseUrl || isLocalOnly) return null;
  return githubCommitUrl(browseBaseUrl, hash);
}
