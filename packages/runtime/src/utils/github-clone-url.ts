/**
 * Redaction for git output that may echo a credential-bearing URL (for example
 * a user-supplied `https://x-access-token:…@github.com/…`). funny itself never
 * puts the token in a URL: see `cloneAuthEnv` in `@funny/core/git`.
 */

/** Remove an embedded token from git output before logging or returning it. */
export function redactGithubToken(text: string): string {
  return text.replace(/x-access-token:[^@]+@/g, 'x-access-token:***@');
}
