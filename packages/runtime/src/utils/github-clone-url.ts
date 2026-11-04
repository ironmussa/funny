/**
 * Per-operation GitHub credentials for `git clone` URLs. The token is only
 * ever placed in the URL handed to git and redacted from anything echoed back.
 */

/** `https://github.com/...` with the token injected; other URLs are returned unchanged. */
export function withGithubToken(cloneUrl: string, token: string | null | undefined): string {
  if (!token || !cloneUrl.startsWith('https://github.com/')) return cloneUrl;
  return cloneUrl.replace('https://github.com/', `https://x-access-token:${token}@github.com/`);
}

/** Remove an injected token from git output before logging or returning it. */
export function redactGithubToken(text: string): string {
  return text.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
}
