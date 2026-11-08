/**
 * Cheap fingerprint of the git state a thread's status depends on (HEAD, its
 * upstream, the given refs and the index file), computed in-process with
 * gitoxide. Used by the git watcher to refresh only the threads whose state
 * moved. Fails when the native module is unavailable: there is no CLI
 * fallback because spawning git here would cost more than the refresh it is
 * meant to avoid.
 */

import { internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync, errAsync } from 'neverthrow';

import { getNativeGit } from './native.js';

/** The refs that track `baseBranch` locally and on `origin`. */
export function baseBranchRefs(baseBranch: string | null | undefined): string[] {
  if (!baseBranch) return [];
  const short = baseBranch.replace(/^refs\/heads\//, '').replace(/^origin\//, '');
  return [`refs/heads/${short}`, `refs/remotes/origin/${short}`];
}

export function getRefFingerprint(
  cwd: string,
  extraRefs: string[],
): ResultAsync<string, DomainError> {
  const native = getNativeGit();
  if (!native) return errAsync(internal('native git unavailable'));
  return ResultAsync.fromPromise(native.getRefFingerprint(cwd, extraRefs), (error) =>
    internal(error instanceof Error ? error.message : String(error)),
  );
}
