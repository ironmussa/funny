/** Parse a git remote URL into a friendly `owner/repo` display string. */
export function formatRemoteUrl(url: string): string {
  const sshMatch = url.match(/[:/]([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/^\//, '').replace(/\.git$/, '');
    return path;
  } catch {
    return url;
  }
}

/** Convert a git remote URL (SSH or HTTPS) to a browseable HTTPS URL. */
export function remoteUrlToBrowseUrl(url: string): string | null {
  const sshMatch = url.match(/^[^@]+@([^:]+):(.+?)(?:\.git)?$/);
  if (sshMatch) {
    const [, host, path] = sshMatch;
    return `https://${host}/${path}`;
  }
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    const path = u.pathname.replace(/\.git$/, '');
    return `https://${u.host}${path}`;
  } catch {
    return null;
  }
}
