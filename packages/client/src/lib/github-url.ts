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
