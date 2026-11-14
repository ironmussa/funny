/**
 * Writes a GitHub App token where `gh` and git read it inside a workspace, and
 * keeps it fresh (sandbox-github-app-tokens). Shared by the sandbox runner
 * (runtime `services/sandbox-github-auth.ts`) and the issue factory.
 *
 * The token goes to gh's `hosts.yml` in a gh config directory, and git's
 * credential helper for github.com points at `gh auth git-credential`, so every
 * `git` and `gh` invocation uses the current token. A refresh loop renews it
 * shortly before it expires (scheduled from its `expiresAt`) without restarting
 * whatever runs there.
 *
 * By default the target is the user's own setup (`~/.config/gh` and the global
 * git config of `homeDir`). A caller that must leave those untouched (a
 * worktree factory run on the user's machine) passes BOTH its own
 * `ghConfigDir` and `gitConfigFile` (a `ghConfigDir` alone still writes the
 * helper to the global git config); the helper then carries `GH_CONFIG_DIR`
 * itself, and the caller points the run's git at that file (for example with
 * `GIT_CONFIG_GLOBAL`).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { GITHUB_APP_TOKEN_RENEW_BEFORE_EXPIRY_MS } from '@funny/shared/github-app-token';
import { Effect, Fiber, Schedule } from 'effect';
import { err, ok, okAsync, ResultAsync, type Result } from 'neverthrow';

import { execute } from '../git/process.js';

export interface WorkspaceGithubToken {
  token: string;
  expiresAt: string;
  repo: string;
}

export interface RenewalTimings {
  /** Renew this long before expiry; shorter than the issuer's reuse margin (#184). */
  renewBeforeExpiryMs?: number;
  /** Floor between renewals, so a token near (or past) its renewal time cannot spin the loop. */
  minDelayMs?: number;
  /** With no valid token, try again this often. */
  retryAfterFailureMs?: number;
}

export interface GithubTokenTarget {
  /** Home of the user git and gh run as. Default: this process's home. */
  homeDir?: string;
  /**
   * Directory gh reads its config from (`GH_CONFIG_DIR`). Default
   * `<homeDir>/.config/gh`; when set, git's helper runs gh with it.
   */
  ghConfigDir?: string;
  /** Git config file for the credential helper. Default: the global config of `homeDir`. */
  gitConfigFile?: string;
}

/** Time as the refresh loop sees it; a fake one lets a test move past a token's expiry. */
export interface RenewalClock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export interface GithubTokenWriterDeps<Key extends string>
  extends GithubTokenTarget, RenewalTimings {
  /** Default: the real clock. */
  clock?: RenewalClock;
  fetchToken(key: Key): Promise<Result<WorkspaceGithubToken, string>>;
  /** Point git's GitHub credential helper at gh. Default: written to the target's git config. */
  configureGit?: () => Promise<Result<void, string>>;
  /** A renewal failed after its retries; the old token stays until the next round. */
  onRenewalFailed?(key: Key, error: string): void;
  retryBaseMs?: number;
}

export interface GithubTokenWriter<Key extends string> {
  /** Fetch the key's token and install it for git and gh. */
  ensure(key: Key): ResultAsync<WorkspaceGithubToken, string>;
  /**
   * Keep the key's token fresh until `stop` (idempotent per key; a new key
   * replaces the previous loop). `expiresAt` is the expiry of the token just
   * installed (null: none).
   */
  startRefresh(key: Key, expiresAt: string | null): void;
  stop(): Promise<void>;
}

const RENEW_BEFORE_EXPIRY_MS = GITHUB_APP_TOKEN_RENEW_BEFORE_EXPIRY_MS;
const MIN_DELAY_MS = 30_000;
/**
 * Most refusals last (App not installed, no access) and the server audits each
 * one, so a workspace without a token asks again slowly.
 */
const RETRY_AFTER_FAILURE_MS = 45 * 60 * 1000;
const RETRY_BASE_MS = 5_000;
const RETRY_TIMES = 5;
const HELPER_KEY = 'credential.https://github.com.helper';

/** How long to wait before renewing a token that expires at `expiresAt` (null: none held). */
export function renewalDelay(
  expiresAt: string | null,
  nowMs: number,
  {
    renewBeforeExpiryMs = RENEW_BEFORE_EXPIRY_MS,
    minDelayMs = MIN_DELAY_MS,
    retryAfterFailureMs = RETRY_AFTER_FAILURE_MS,
  }: RenewalTimings = {},
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

function writeGhHosts(dir: string, token: string): Result<void, string> {
  try {
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

const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The helper command git runs; it names the gh config directory when it is not gh's default. */
export function ghCredentialHelper(ghConfigDir?: string): string {
  return ghConfigDir
    ? `!GH_CONFIG_DIR=${shellQuote(ghConfigDir)} gh auth git-credential`
    : '!gh auth git-credential';
}

/** The empty helper resets any inherited one, so only gh answers for github.com. */
async function configureGitWithGh(
  homeDir: string,
  target: GithubTokenTarget,
): Promise<Result<void, string>> {
  const scope = target.gitConfigFile ? ['--file', target.gitConfigFile] : ['--global'];
  const env = { HOME: homeDir };
  const helper = ghCredentialHelper(target.ghConfigDir);
  try {
    await execute('git', ['config', ...scope, '--unset-all', HELPER_KEY], { env, reject: false });
    await execute('git', ['config', ...scope, '--add', HELPER_KEY, ''], { env });
    await execute('git', ['config', ...scope, '--add', HELPER_KEY, helper], { env });
    return ok(undefined);
  } catch (error) {
    return err(`could not configure git's GitHub credential helper: ${String(error)}`);
  }
}

export function createGithubTokenWriter<Key extends string>(
  deps: GithubTokenWriterDeps<Key>,
): GithubTokenWriter<Key> {
  const homeDir = deps.homeDir ?? homedir();
  const ghDir = deps.ghConfigDir ?? join(homeDir, '.config', 'gh');
  const configureGit = deps.configureGit ?? (() => configureGitWithGh(homeDir, deps));
  const retryBaseMs = deps.retryBaseMs ?? RETRY_BASE_MS;
  const clock = deps.clock;
  const now = () => (clock ? clock.now() : Date.now());
  /** Interruptible either way: interrupting the fiber abandons a pending fake sleep. */
  const wait = (ms: number) => (clock ? Effect.promise(() => clock.sleep(ms)) : Effect.sleep(ms));
  let gitConfigured = false;
  let refresh: { key: Key; fiber: Fiber.Fiber<unknown, unknown> } | null = null;

  function ensure(key: Key): ResultAsync<WorkspaceGithubToken, string> {
    return ResultAsync.fromPromise(deps.fetchToken(key), (error) => String(error))
      .andThen((token) => token)
      .andThen((token) => writeGhHosts(ghDir, token.token).map(() => token))
      .andThen((token) => {
        if (gitConfigured) return okAsync(token);
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
  const renewal = (key: Key) =>
    Effect.retry(
      Effect.tryPromise({ try: () => ensure(key), catch: (error) => error }).pipe(
        Effect.flatMap((result) =>
          result.isOk()
            ? Effect.succeed(result.value.expiresAt)
            : Effect.fail(new Error(result.error)),
        ),
      ),
      { schedule: Schedule.exponential(retryBaseMs), times: RETRY_TIMES },
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.sync((): string | null => {
          deps.onRenewalFailed?.(key, String(cause));
          return null;
        }),
      ),
    );

  /** Sleep until the held token is due, renew it, repeat. A failed renewal keeps the old expiry. */
  const refreshLoop = (key: Key, expiresAt: string | null): Effect.Effect<never> =>
    Effect.suspend(() => wait(renewalDelay(expiresAt, now(), deps))).pipe(
      Effect.andThen(renewal(key)),
      Effect.flatMap((renewed) => refreshLoop(key, renewed ?? expiresAt)),
    );

  return {
    ensure,
    startRefresh(key, expiresAt) {
      if (refresh?.key === key) return;
      if (refresh) Effect.runFork(Fiber.interrupt(refresh.fiber));
      const fiber = Effect.runFork(refreshLoop(key, expiresAt));
      refresh = { key, fiber };
    },
    async stop() {
      const current = refresh;
      refresh = null;
      if (current) await Effect.runPromise(Fiber.interrupt(current.fiber));
    },
  };
}
