/**
 * @domain subdomain: Agent Execution
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: infrastructure
 *
 * GitHub access inside a sandbox (sandbox-github-app-tokens). The server mints a
 * GitHub App token restricted to the thread's repository, valid for an hour;
 * this service writes it where `gh` reads it (`hosts.yml`) and points git's
 * credential helper at `gh auth git-credential`, so every `git` and `gh`
 * invocation uses the current token. A refresh loop renews it shortly before it
 * expires (scheduled from its `expiresAt`) without restarting the agent. The
 * owner's PAT is never involved. Writing and renewing is the shared writer in
 * `@funny/core/github-app`; this service feeds it the server's replies.
 */

import {
  createGithubTokenWriter,
  type GithubTokenWriter,
  type RenewalTimings,
  type WorkspaceGithubToken,
} from '@funny/core/github-app';
import { err, ok, type Result } from 'neverthrow';

import { log } from '../lib/logger.js';
import { isSandboxRunner } from './sandbox-runner.js';

export { renewalDelay } from '@funny/core/github-app';

export type GithubAppToken = WorkspaceGithubToken;

/** What the server answers to `data:get_github_app_token`. */
export interface GithubAppTokenReply {
  token?: string;
  expiresAt?: string;
  repo?: string;
  error?: string;
  message?: string;
}

export interface SandboxGithubAuthDeps extends RenewalTimings {
  fetchToken(threadId: string): Promise<GithubAppTokenReply | null>;
  /** Home of the user git and gh run as (the agent's HOME). */
  homeDir?: string;
  /** Point git's GitHub credential helper at gh (global config). */
  configureGit?: () => Promise<Result<void, string>>;
  retryBaseMs?: number;
}

function asToken(reply: GithubAppTokenReply | null): Result<GithubAppToken, string> {
  if (reply?.token && reply.expiresAt && reply.repo) {
    return ok({ token: reply.token, expiresAt: reply.expiresAt, repo: reply.repo });
  }
  return err(reply?.message ?? reply?.error ?? 'no GitHub token for this thread');
}

export function createSandboxGithubAuth(deps: SandboxGithubAuthDeps): GithubTokenWriter<string> {
  const { fetchToken, ...rest } = deps;
  return createGithubTokenWriter<string>({
    ...rest,
    fetchToken: async (threadId) => asToken(await fetchToken(threadId)),
    onRenewalFailed: (threadId, error) =>
      log.warn('Could not renew the sandbox GitHub token', {
        namespace: 'sandbox-github',
        threadId,
        error,
      }),
  });
}

let production: GithubTokenWriter<string> | null = null;

/** This sandbox runner's GitHub auth, fed by the server over the data channel. */
function sandboxGithubAuth() {
  production ??= createSandboxGithubAuth({
    fetchToken: async (threadId) => {
      const { remoteGetGithubAppToken } = await import('./remote-project-identity-client.js');
      return remoteGetGithubAppToken(threadId);
    },
  });
  return production;
}

/**
 * Install (or renew) the thread's GitHub token and keep it fresh. Best effort:
 * without it the agent still runs, only GitHub is unavailable, and the reason
 * is logged. Returns the token for callers that need it right away (the clone).
 */
export async function prepareSandboxGithub(threadId: string): Promise<GithubAppToken | null> {
  const auth = sandboxGithubAuth();
  const token = await auth.ensure(threadId);
  auth.startRefresh(threadId, token.isOk() ? token.value.expiresAt : null);
  if (token.isErr()) {
    log.warn('No GitHub access for this sandbox thread', {
      namespace: 'sandbox-github',
      threadId,
      reason: token.error,
    });
    return null;
  }
  return token.value;
}

/** Before an agent starts: on a sandbox runner, install and keep fresh its GitHub token. */
export async function prepareAgentGithub(threadId: string): Promise<void> {
  if (isSandboxRunner()) await prepareSandboxGithub(threadId);
}
