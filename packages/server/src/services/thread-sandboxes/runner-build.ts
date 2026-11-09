/**
 * Which funny build a sandbox runner must run (change thread-sandboxes).
 *
 * The runner in a sandbox must speak the same `runner.v2` protocol as this
 * server, so templates and on-the-fly installs use the server's own commit,
 * cloned from the public repository. The deploy sets `FUNNY_BUILD_COMMIT`
 * (Railway sets `RAILWAY_GIT_COMMIT_SHA` itself for GitHub-sourced deploys).
 * A server running from a git checkout (local development) falls back to its
 * HEAD, provided that commit is pushed — the sandbox clones it from the remote.
 */

import { gitRead } from '@funny/core/git';
import { err, ok, type Result } from 'neverthrow';

const DEFAULT_FUNNY_REPO_URL = 'https://github.com/ironmussa/funny.git';

export interface RunnerBuild {
  /** Full 40-char commit sha of this server's build. */
  commit: string;
  /** Short, template-safe version id derived from the commit. */
  version: string;
  repoUrl: string;
}

/** HEAD of the git checkout the server runs from. */
export interface LocalCheckout {
  commit: string;
  /** Whether a remote-tracking branch contains `commit`. */
  pushed: boolean;
}

export type RunnerBuildError =
  | { kind: 'missing-build-commit'; message: string }
  | { kind: 'build-commit-not-pushed'; message: string };

const SHA_RE = /^[0-9a-f]{40}$/;

export function resolveRunnerBuild(
  env: Readonly<Record<string, string | undefined>> = process.env,
  local: LocalCheckout | null = null,
): Result<RunnerBuild, RunnerBuildError> {
  const repoUrl = (env.FUNNY_REPO_URL || DEFAULT_FUNNY_REPO_URL).trim();
  const configured = (env.FUNNY_BUILD_COMMIT || env.RAILWAY_GIT_COMMIT_SHA || '')
    .trim()
    .toLowerCase();
  const localCommit = local?.commit.trim().toLowerCase() ?? '';

  if (!configured && SHA_RE.test(localCommit)) {
    if (!local?.pushed) {
      return err({
        kind: 'build-commit-not-pushed',
        message: `Sandboxes install the runner from the server's commit, and the local commit ${localCommit.slice(0, 9)} is not pushed: push it to ${repoUrl} (or set FUNNY_BUILD_COMMIT to a pushed commit).`,
      });
    }
    return ok({ commit: localCommit, version: localCommit.slice(0, 12), repoUrl });
  }

  if (!SHA_RE.test(configured)) {
    return err({
      kind: 'missing-build-commit',
      message:
        'Sandboxes need the server build commit: set FUNNY_BUILD_COMMIT to the full sha of the deployed commit (it must be pushed to the repository).',
    });
  }
  return ok({ commit: configured, version: configured.slice(0, 12), repoUrl });
}

/** HEAD of the checkout at `cwd`, or null when the server is not in a git checkout. */
async function readLocalCheckout(cwd: string = process.cwd()): Promise<LocalCheckout | null> {
  try {
    const head = await gitRead(['rev-parse', 'HEAD'], { cwd, reject: false });
    const commit = head.stdout.trim();
    if (head.exitCode !== 0 || !SHA_RE.test(commit)) return null;
    const remotes = await gitRead(['branch', '-r', '--contains', commit], { cwd, reject: false });
    return { commit, pushed: remotes.exitCode === 0 && remotes.stdout.trim().length > 0 };
  } catch {
    return null;
  }
}

/** The build for this server: env first, then the local checkout's HEAD. */
export async function resolveServerRunnerBuild(): Promise<Result<RunnerBuild, RunnerBuildError>> {
  const env = process.env;
  const configured = env.FUNNY_BUILD_COMMIT || env.RAILWAY_GIT_COMMIT_SHA;
  return resolveRunnerBuild(env, configured ? null : await readLocalCheckout());
}
