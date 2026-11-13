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
 * owner's PAT is never involved.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { execute } from '@funny/core/git';
import { GITHUB_APP_TOKEN_RENEW_BEFORE_EXPIRY_MS } from '@funny/shared/github-app-token';
import { Effect, Fiber, Schedule } from 'effect';
import { err, ok, ResultAsync, type Result } from 'neverthrow';

import { log } from '../lib/logger.js';
import { isSandboxRunner } from './sandbox-runner.js';

export interface GithubAppToken {
  token: string;
  expiresAt: string;
  repo: string;
}

/** What the server answers to `data:get_github_app_token`. */
export interface GithubAppTokenReply {
  token?: string;
  expiresAt?: string;
  repo?: string;
  error?: string;
  message?: string;
}

export interface SandboxGithubAuthDeps {
  fetchToken(threadId: string): Promise<GithubAppTokenReply | null>;
  /** Home of the user git and gh run as (the agent's HOME). */
  homeDir?: string;
  /** Point git's GitHub credential helper at gh (global config). */
  configureGit?: () => Promise<Result<void, string>>;
  renewBeforeExpiryMs?: number;
  minDelayMs?: number;
  retryAfterFailureMs?: number;
  retryBaseMs?: number;
}

/** Shorter than the server's reuse margin, so the server mints a new token (#184). */
const RENEW_BEFORE_EXPIRY_MS = GITHUB_APP_TOKEN_RENEW_BEFORE_EXPIRY_MS;
/** Floor between renewals, so a token near (or past) its renewal time cannot spin the loop. */
const MIN_DELAY_MS = 30_000;
/**
 * With no valid token (the server refused, or the last one expired): try again
 * this often. Most refusals last (App not installed, no access) and each one is
 * audited on the server, so this stays slow.
 */
const RETRY_AFTER_FAILURE_MS = 45 * 60 * 1000;
const RETRY_BASE_MS = 5_000;
const RETRY_TIMES = 5;

/** How long to wait before renewing a token that expires at `expiresAt` (null: none held). */
export function renewalDelay(
  expiresAt: string | null,
  nowMs: number,
  {
    renewBeforeExpiryMs = RENEW_BEFORE_EXPIRY_MS,
    minDelayMs = MIN_DELAY_MS,
    retryAfterFailureMs = RETRY_AFTER_FAILURE_MS,
  }: Pick<SandboxGithubAuthDeps, 'renewBeforeExpiryMs' | 'minDelayMs' | 'retryAfterFailureMs'> = {},
): number {
  const expiry = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(expiry) || expiry <= nowMs) return retryAfterFailureMs;
  return Math.max(minDelayMs, expiry - renewBeforeExpiryMs - nowMs);
}

/**
 * gh's hosts file with the App token for github.com, in gh's multi-account
 * format (gh 2.40+). gh reads it on every call, so a renewal applies at once.
 */
function ghHostsYaml(token: string): string {
  return [
    'github.com:',
    '    users:',
    '        x-access-token:',
    `            oauth_token: ${token}`,
    '    git_protocol: https',
    `    oauth_token: ${token}`,
    '    user: x-access-token',
    '',
  ].join('\n');
}

/**
 * gh migrates a config without `version: "1"` to the multi-account format by
 * calling GitHub, which fails with an App token; mark it as current.
 */
function ensureGhConfigVersion(dir: string): void {
  const file = join(dir, 'config.yml');
  const current = existsSync(file) ? readFileSync(file, 'utf8') : '';
  if (/^version:\s*"?1"?\s*$/m.test(current)) return;
  writeFileSync(file, `version: "1"\n${current}`, { mode: 0o600 });
}

function writeGhHosts(homeDir: string, token: string): Result<void, string> {
  try {
    const dir = join(homeDir, '.config', 'gh');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    ensureGhConfigVersion(dir);
    const file = join(dir, 'hosts.yml');
    writeFileSync(file, ghHostsYaml(token), { mode: 0o600 });
    chmodSync(file, 0o600);
    return ok(undefined);
  } catch (error) {
    return err(`could not write gh hosts.yml: ${String(error)}`);
  }
}

/** The empty helper resets any inherited one, so only gh answers for github.com. */
async function configureGitWithGh(homeDir: string): Promise<Result<void, string>> {
  const key = 'credential.https://github.com.helper';
  const env = { HOME: homeDir };
  try {
    await execute('git', ['config', '--global', '--unset-all', key], { env, reject: false });
    await execute('git', ['config', '--global', '--add', key, ''], { env });
    await execute('git', ['config', '--global', '--add', key, '!gh auth git-credential'], { env });
    return ok(undefined);
  } catch (error) {
    return err(`could not configure git's GitHub credential helper: ${String(error)}`);
  }
}

function asToken(reply: GithubAppTokenReply | null): Result<GithubAppToken, string> {
  if (reply?.token && reply.expiresAt && reply.repo) {
    return ok({ token: reply.token, expiresAt: reply.expiresAt, repo: reply.repo });
  }
  return err(reply?.message ?? reply?.error ?? 'no GitHub token for this thread');
}

export function createSandboxGithubAuth(deps: SandboxGithubAuthDeps) {
  const homeDir = deps.homeDir ?? homedir();
  const configureGit = deps.configureGit ?? (() => configureGitWithGh(homeDir));
  const retryBaseMs = deps.retryBaseMs ?? RETRY_BASE_MS;
  let gitConfigured = false;
  let refresh: { threadId: string; fiber: Fiber.Fiber<unknown, unknown> } | null = null;

  /** Fetch the thread's token and install it for git and gh. */
  function ensure(threadId: string): ResultAsync<GithubAppToken, string> {
    return ResultAsync.fromPromise(deps.fetchToken(threadId), (error) => String(error))
      .andThen((reply) => asToken(reply))
      .andThen((token) => writeGhHosts(homeDir, token.token).map(() => token))
      .andThen((token) => {
        if (gitConfigured) return ResultAsync.fromSafePromise(Promise.resolve(token));
        return ResultAsync.fromSafePromise(configureGit()).andThen((configured) =>
          configured.map(() => {
            gitConfigured = true;
            return token;
          }),
        );
      });
  }

  /**
   * One renewal, retried with exponential backoff before giving up until the
   * next round. Yields the new token's expiry, or null when it failed.
   */
  const renewal = (threadId: string) =>
    Effect.retry(
      Effect.tryPromise({
        try: async (): Promise<string | null> => {
          const result = await ensure(threadId);
          if (result.isErr()) throw new Error(result.error);
          return result.value.expiresAt;
        },
        catch: (error) => error,
      }),
      { schedule: Schedule.exponential(retryBaseMs), times: RETRY_TIMES },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.sync((): string | null => {
          log.warn('Could not renew the sandbox GitHub token', {
            namespace: 'sandbox-github',
            threadId,
            error: String(cause),
          });
          return null;
        }),
      ),
    );

  /** Sleep until the held token is due, renew it, repeat. A failed renewal keeps the old expiry. */
  const refreshLoop = (threadId: string, expiresAt: string | null): Effect.Effect<never> =>
    Effect.suspend(() => Effect.sleep(renewalDelay(expiresAt, Date.now(), deps))).pipe(
      Effect.andThen(renewal(threadId)),
      Effect.flatMap((renewed) => refreshLoop(threadId, renewed ?? expiresAt)),
    );

  return {
    ensure,
    /**
     * Keep the thread's token fresh until `stop` (idempotent per thread).
     * `expiresAt` is the expiry of the token just installed (null: none).
     */
    startRefresh(threadId: string, expiresAt: string | null): void {
      if (refresh?.threadId === threadId) return;
      if (refresh) Effect.runFork(Fiber.interrupt(refresh.fiber));
      const fiber = Effect.runFork(refreshLoop(threadId, expiresAt));
      refresh = { threadId, fiber };
    },
    async stop(): Promise<void> {
      const current = refresh;
      refresh = null;
      if (current) await Effect.runPromise(Fiber.interrupt(current.fiber));
    },
  };
}

let production: ReturnType<typeof createSandboxGithubAuth> | null = null;

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
