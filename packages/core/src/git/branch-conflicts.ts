/**
 * Whether pairs of remote branches merge without a conflict, without writing a
 * branch or a worktree (openspec factory-lanes D7): the factory's cross-lane
 * conflict check.
 *
 * It fetches (which only moves remote-tracking refs), then runs
 * `git merge-tree --write-tree --name-only` for each pair of
 * `origin/<branch>`. `merge-tree` writes the merged tree's objects to the
 * object store, never a ref, the index or the working tree. It needs git 2.38
 * or later; with an older git the check reports itself `unavailable` instead
 * of guessing.
 */

import type { DomainError } from '@funny/shared/errors';
import { internal } from '@funny/shared/errors';
import { err, ok, type Result, ResultAsync } from 'neverthrow';

import type { GitIdentityOptions } from './base.js';
import { fetchRemote } from './branch.js';
import { gitRead } from './process.js';
import { isSafeGitRefArg } from './ref-guard.js';

/** The first git with `merge-tree --write-tree` (and `--name-only`). */
const MIN_GIT_VERSION: readonly [number, number] = [2, 38];

/** Two branches whose merge conflicts, and the paths it conflicts on. */
export interface BranchConflictPair {
  a: string;
  b: string;
  paths: string[];
}

export type BranchConflictReport =
  /** The check could not run here (git too old); nothing was compared. */
  | { kind: 'unavailable'; reason: string }
  | {
      kind: 'checked';
      /** The pairs that conflict; a pair that merges cleanly is not listed. */
      conflicts: BranchConflictPair[];
      /** Branches the remote does not have (or that are not valid ref names): left out. */
      missing: string[];
      /** False when the fetch failed: the comparison used the refs from the last fetch. */
      fetched: boolean;
    };

/** `[major, minor]` from `git version 2.43.0` (or `git version 2.39.3 (Apple Git-146)`). */
export function parseGitVersion(text: string): [number, number] | null {
  const match = /git version (\d+)\.(\d+)/.exec(text);
  return match ? [Number(match[1]), Number(match[2])] : null;
}

function supportsWriteTree(version: readonly [number, number]): boolean {
  const [major, minor] = version;
  return (
    major > MIN_GIT_VERSION[0] || (major === MIN_GIT_VERSION[0] && minor >= MIN_GIT_VERSION[1])
  );
}

/** Every unordered pair of `items`, in order. */
function pairsOf<T>(items: readonly T[]): [T, T][] {
  const pairs: [T, T][] = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) pairs.push([items[i], items[j]]);
  }
  return pairs;
}

async function remoteRefExists(cwd: string, branch: string): Promise<boolean> {
  const found = await gitRead(
    ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}^{commit}`],
    {
      cwd,
      reject: false,
    },
  );
  return found.exitCode === 0;
}

/**
 * The conflicting paths of merging `origin/a` and `origin/b`: empty when they
 * merge cleanly. Exit 1 is a conflict; anything else is an error.
 */
async function conflictingPaths(
  cwd: string,
  a: string,
  b: string,
): Promise<Result<string[], DomainError>> {
  const merged = await gitRead(
    [
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      `refs/remotes/origin/${a}`,
      `refs/remotes/origin/${b}`,
    ],
    { cwd, reject: false, timeout: 120_000 },
  );
  if (merged.exitCode === 0) return ok([]);
  if (merged.exitCode !== 1) {
    const why = merged.stderr.trim() || `exit ${merged.exitCode}`;
    return err(internal(`git merge-tree ${a} ${b} failed: ${why}`));
  }
  // The first line is the merged tree's id; the conflicted paths follow.
  const paths = merged.stdout
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean);
  return ok([...new Set(paths)]);
}

async function check(
  cwd: string,
  branches: readonly string[],
  identity: GitIdentityOptions | undefined,
): Promise<Result<BranchConflictReport, DomainError>> {
  const versionText = await gitRead(['--version'], { cwd, reject: false });
  const version = parseGitVersion(versionText.stdout);
  if (!version || !supportsWriteTree(version)) {
    const found = version ? version.join('.') : 'unknown';
    return ok({
      kind: 'unavailable',
      reason: `git ${MIN_GIT_VERSION.join('.')} or later is needed (found ${found})`,
    });
  }

  const fetched = await fetchRemote(cwd, identity);
  const present: string[] = [];
  const missing: string[] = [];
  for (const branch of new Set(branches)) {
    if (isSafeGitRefArg(branch) && (await remoteRefExists(cwd, branch))) present.push(branch);
    else missing.push(branch);
  }

  const conflicts: BranchConflictPair[] = [];
  for (const [a, b] of pairsOf(present)) {
    const paths = await conflictingPaths(cwd, a, b);
    if (paths.isErr()) return err(paths.error);
    if (paths.value.length > 0) conflicts.push({ a, b, paths: paths.value });
  }
  return ok({ kind: 'checked', conflicts, missing, fetched: fetched.isOk() && fetched.value });
}

/** Whether each pair of `branches` (as `origin/<branch>`) merges without a conflict. */
export function checkBranchConflicts(
  cwd: string,
  branches: readonly string[],
  identity?: GitIdentityOptions,
): ResultAsync<BranchConflictReport, DomainError> {
  return ResultAsync.fromPromise(check(cwd, branches, identity), (error) =>
    internal(error instanceof Error ? error.message : String(error)),
  ).andThen((report) => report);
}
