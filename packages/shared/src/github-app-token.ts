/**
 * Timing contract between the server, which caches sandbox GitHub App tokens
 * (server `services/github-app/token-issuer.ts`), and the sandbox runner, which
 * renews them (runtime `services/sandbox-github-auth.ts`).
 */

/** The server hands back a cached token until this long before it expires. */
export const GITHUB_APP_TOKEN_REUSE_MARGIN_MS = 10 * 60 * 1000;

/**
 * The runner asks for the next token this long before the current one
 * expires. It must be shorter than the reuse margin, or the server answers
 * with the same token, which then expires in the sandbox (#184). Half the
 * margin leaves room for retries and for clock skew either way.
 */
export const GITHUB_APP_TOKEN_RENEW_BEFORE_EXPIRY_MS = GITHUB_APP_TOKEN_REUSE_MARGIN_MS / 2;
