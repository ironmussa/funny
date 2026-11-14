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
  /** Whether a remote-tracking branch of the funny repository contains `commit`. */
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

/** `host/owner/repo` of a git URL (https, ssh or scp-like), for comparing remotes. */
function repositoryKey(url: string): string {
  return url
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, '')
    .replace(/^[^@/]+@/, '')
    .replace(/^([^/:]+):(?!\d+\/)/, '$1/')
    .replace(/:\d+\//, '/')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/** Whether two git URLs name the same repository (`git@github.com:a/b` = `https://github.com/a/b.git`). */
export function sameRepository(a: string, b: string): boolean {
  return repositoryKey(a) === repositoryKey(b);
}

/**
 * HEAD of the checkout at `cwd`, when it is a checkout of `repoUrl` (a remote
 * of it points there); null otherwise, e.g. a server started inside another
 * project's repository, whose commits the sandbox could never clone.
 */
async function readLocalCheckout(
  repoUrl: string,
  cwd: string = process.cwd(),
): Promise<LocalCheckout | null> {
  try {
    const head = await gitRead(['rev-parse', 'HEAD'], { cwd, reject: false });
    const commit = head.stdout.trim();
    if (head.exitCode !== 0 || !SHA_RE.test(commit)) return null;
    const listed = await gitRead(['remote', '-v'], { cwd, reject: false });
    const remotes = new Set(
      listed.stdout
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter(([name, url]) => name && url && sameRepository(url, repoUrl))
        .map(([name]) => name),
    );
    if (remotes.size === 0) return null;
    // Pushed: a remote-tracking branch of one of those remotes contains it.
    const branches = await gitRead(['branch', '-r', '--contains', commit], { cwd, reject: false });
    const pushed =
      branches.exitCode === 0 &&
      branches.stdout.split('\n').some((line) => remotes.has(line.trim().split('/')[0] ?? ''));
    return { commit, pushed };
  } catch {
    return null;
  }
}

/** The build for this server: env first, then the local checkout's HEAD. */
export async function resolveServerRunnerBuild(): Promise<Result<RunnerBuild, RunnerBuildError>> {
  const env = process.env;
  const configured = env.FUNNY_BUILD_COMMIT || env.RAILWAY_GIT_COMMIT_SHA;
  const repoUrl = (env.FUNNY_REPO_URL || DEFAULT_FUNNY_REPO_URL).trim();
  return resolveRunnerBuild(env, configured ? null : await readLocalCheckout(repoUrl));
}
