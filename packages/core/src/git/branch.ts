/**
 * Branch management: listing, detection, remote URL, init.
 */

import type { DomainError } from '@funny/shared/errors';
import { processError, internal } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { git, gitOptional, type GitIdentityOptions, gitRemote } from './base.js';
import { getNativeGit } from './native.js';
import { gitNetwork, gitRead } from './process.js';

/**
 * Get the current branch name.
 */
export function getCurrentBranch(cwd: string): ResultAsync<string, DomainError> {
  const native = getNativeGit();
  if (native) {
    return ResultAsync.fromPromise(
      native.getCurrentBranch(cwd).then(async (b) => {
        if (b) return b;
        // Fallback for repos with no commits: native module may return null
        const symRef = await gitRead(['symbolic-ref', '--short', 'HEAD'], { cwd, reject: false });
        return symRef.exitCode === 0 ? symRef.stdout.trim() : '';
      }),
      (error) => processError(String(error), 1, ''),
    );
  }
  // CLI fallback
  return ResultAsync.fromPromise(
    gitRead(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, reject: false }).then(async (r) => {
      if (r.exitCode === 0) return r.stdout.trim();
      // Fallback for repos with no commits: symbolic-ref still works
      const symRef = await gitRead(['symbolic-ref', '--short', 'HEAD'], { cwd, reject: false });
      return symRef.exitCode === 0 ? symRef.stdout.trim() : '';
    }),
    (error) => processError(String(error), 1, ''),
  );
}

/**
 * List all branches in the repository.
 * Falls back to remote branches if no local branches exist.
 */
export function listBranches(cwd: string): ResultAsync<string[], DomainError> {
  const native = getNativeGit();
  if (native) {
    return ResultAsync.fromPromise(native.listBranches(cwd), (error) =>
      processError(String(error), 1, ''),
    );
  }
  // CLI fallback
  return ResultAsync.fromPromise(
    (async () => {
      const seen = new Set<string>();
      const branches: string[] = [];

      // Local branches first
      const localOutput = await gitOptional(['branch', '--format=%(refname:short)'], cwd);
      if (localOutput) {
        for (const b of localOutput
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)) {
          seen.add(b);
          branches.push(b);
        }
      }

      // Always include remote branches that don't exist locally
      const remoteOutput = await gitOptional(['branch', '-r', '--format=%(refname:short)'], cwd);
      if (remoteOutput) {
        for (const raw of remoteOutput
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)) {
          if (!raw.startsWith('origin/')) continue;
          const name = raw.slice('origin/'.length);
          if (name && !name.includes('HEAD') && !seen.has(name)) {
            seen.add(name);
            branches.push(name);
          }
        }
      }

      if (branches.length > 0)
        return branches.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

      // Fall back to symbolic-ref for empty repos (no commits yet)
      const symbolicBranch = await gitOptional(['symbolic-ref', '--short', 'HEAD'], cwd);
      if (symbolicBranch) return [symbolicBranch];

      return [];
    })(),
    (error) => internal(String(error)),
  );
}

export interface BranchInfo {
  name: string;
  isLocal: boolean;
  isRemote: boolean;
}

/**
 * List branches with metadata about whether each exists locally and/or on origin.
 */
export function listBranchesDetailed(cwd: string): ResultAsync<BranchInfo[], DomainError> {
  const native = getNativeGit();
  if (native) {
    return ResultAsync.fromPromise(
      native.listBranchesDetailed(cwd).then(async (branches) => {
        if (branches.length > 0) return branches;
        // Fall back to symbolic-ref for empty repos
        const symbolicBranch = await gitOptional(['symbolic-ref', '--short', 'HEAD'], cwd);
        if (symbolicBranch) return [{ name: symbolicBranch, isLocal: true, isRemote: false }];
        return [];
      }),
      (error) => internal(String(error)),
    );
  }
  return ResultAsync.fromPromise(
    (async () => {
      const localSet = new Set<string>();
      const remoteSet = new Set<string>();

      // Collect local branch names
      const localOutput = await gitOptional(['branch', '--format=%(refname:short)'], cwd);
      if (localOutput) {
        for (const b of localOutput
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)) {
          localSet.add(b);
        }
      }

      // Collect remote branch names (strip origin/ prefix)
      const remoteOutput = await gitOptional(['branch', '-r', '--format=%(refname:short)'], cwd);
      if (remoteOutput) {
        for (const raw of remoteOutput
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean)) {
          if (raw.includes('HEAD')) continue;
          if (!raw.startsWith('origin/')) continue;
          const name = raw.slice('origin/'.length);
          if (name) {
            remoteSet.add(name);
          }
        }
      }

      // Merge into unified list
      const allNames = new Set([...localSet, ...remoteSet]);
      const branches: BranchInfo[] = [];
      for (const name of allNames) {
        branches.push({
          name,
          isLocal: localSet.has(name),
          isRemote: remoteSet.has(name),
        });
      }

      if (branches.length > 0)
        return branches.sort((a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }),
        );

      // Fall back to symbolic-ref for empty repos (no commits yet)
      const symbolicBranch = await gitOptional(['symbolic-ref', '--short', 'HEAD'], cwd);
      if (symbolicBranch) return [{ name: symbolicBranch, isLocal: true, isRemote: false }];

      return [];
    })(),
    (error) => internal(String(error)),
  );
}

/**
 * Fetch remote refs so branch listings are up-to-date.
 * Non-blocking: returns ok(true) on success, ok(false) if fetch fails (e.g. no remote).
 * When called without identity, falls back to unauthenticated fetch (public repos only).
 */
export function fetchRemote(
  cwd: string,
  identity?: GitIdentityOptions,
): ResultAsync<boolean, DomainError> {
  if (identity?.githubToken) {
    return gitRemote(['fetch', '--prune', '--quiet'], cwd, identity).map(() => true);
  }
  return ResultAsync.fromPromise(
    (async () => {
      // `fetch --quiet` prints nothing, so judge success by the exit code
      // (gitOptional would read empty output as a failure).
      const result = await gitNetwork(['fetch', '--prune', '--quiet'], {
        cwd,
        reject: false,
        env: { GIT_TERMINAL_PROMPT: '0' },
        timeout: 120_000,
      });
      return result.exitCode === 0;
    })(),
    (error) => internal(String(error)),
  );
}

/**
 * Detect the default branch of the repository.
 */
export function getDefaultBranch(cwd: string): ResultAsync<string | null, DomainError> {
  const native = getNativeGit();
  if (native) {
    return ResultAsync.fromPromise(native.getDefaultBranch(cwd), (error) =>
      processError(String(error), 1, ''),
    );
  }
  return ResultAsync.fromPromise(
    (async () => {
      const remoteHead = await gitOptional(
        ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        cwd,
      );
      if (remoteHead) {
        return remoteHead.replace(/^origin\//, '');
      }

      const branchesResult = await listBranches(cwd);
      if (branchesResult.isErr()) return null;
      const branches = branchesResult.value;
      if (branches.includes('main')) return 'main';
      if (branches.includes('master')) return 'master';
      if (branches.includes('develop')) return 'develop';

      return branches.length > 0 ? branches[0] : null;
    })(),
    (error) => internal(String(error)),
  );
}

/**
 * Get the remote URL for origin
 */
export function getRemoteUrl(cwd: string): ResultAsync<string | null, DomainError> {
  const native = getNativeGit();
  if (native) {
    return ResultAsync.fromPromise(native.getRemoteUrl(cwd), (error) =>
      processError(String(error), 1, ''),
    );
  }
  return ResultAsync.fromPromise(gitOptional(['remote', 'get-url', 'origin'], cwd), (error) =>
    internal(String(error)),
  );
}

/**
 * Extract repository name from remote URL
 */
export function extractRepoName(remoteUrl: string): string {
  return (
    remoteUrl
      .replace(/\.git$/, '')
      .split(/[/:]/)
      .pop() || ''
  );
}

/**
 * Initialize a new git repository
 */
export function initRepo(cwd: string): ResultAsync<void, DomainError> {
  return git(['init'], cwd).map(() => undefined);
}
