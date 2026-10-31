/**
 * Which funny build a sandbox runner must run (change thread-sandboxes).
 *
 * The runner in a sandbox must speak the same `runner.v2` protocol as this
 * server, so templates and on-the-fly installs use the server's own commit,
 * cloned from the public repository. The deploy sets `FUNNY_BUILD_COMMIT`
 * (Railway sets `RAILWAY_GIT_COMMIT_SHA` itself for GitHub-sourced deploys).
 */

import { err, ok, type Result } from 'neverthrow';

export const DEFAULT_FUNNY_REPO_URL = 'https://github.com/ironmussa/funny.git';

export interface RunnerBuild {
  /** Full 40-char commit sha of this server's build. */
  commit: string;
  /** Short, template-safe version id derived from the commit. */
  version: string;
  repoUrl: string;
}

export type RunnerBuildError = { kind: 'missing-build-commit'; message: string };

export function resolveRunnerBuild(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Result<RunnerBuild, RunnerBuildError> {
  const commit = (env.FUNNY_BUILD_COMMIT || env.RAILWAY_GIT_COMMIT_SHA || '').trim().toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(commit)) {
    return err({
      kind: 'missing-build-commit',
      message:
        'Sandboxes need the server build commit: set FUNNY_BUILD_COMMIT to the full sha of the deployed commit (it must be pushed to the repository).',
    });
  }
  return ok({
    commit,
    version: commit.slice(0, 12),
    repoUrl: (env.FUNNY_REPO_URL || DEFAULT_FUNNY_REPO_URL).trim(),
  });
}
