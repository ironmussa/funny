/**
 * Defensive guard for user-influenced git refs (commit hashes, branch names)
 * that core passes POSITIONALLY to git. A value starting with `-` would be
 * parsed as an option (`--output=/tmp/x` writes an arbitrary file), so core
 * refuses such refs even when the route layer already validated them —
 * persisted values (e.g. a thread's `baseBranch`) can predate that validation.
 */

import { badRequest, type DomainError } from '@funny/shared/errors';
import { err, errAsync, ok, type Result, type ResultAsync } from 'neverthrow';

// eslint-disable-next-line no-control-regex
const UNSAFE_REF_CHARS = /[\s\x00-\x1f\x7f]/;

/** True when `ref` can be passed positionally to git without being read as an option. */
export function isSafeGitRefArg(ref: string | null | undefined): ref is string {
  return (
    typeof ref === 'string' &&
    ref.length > 0 &&
    ref.length <= 1024 &&
    !ref.startsWith('-') &&
    !UNSAFE_REF_CHARS.test(ref)
  );
}

/** Result-returning form of {@link isSafeGitRefArg}. */
function requireSafeGitRef(ref: string, label = 'ref'): Result<string, DomainError> {
  return isSafeGitRefArg(ref) ? ok(ref) : err(badRequest(`Invalid git ${label}: ${ref}`));
}

/**
 * Run `run` only when `ref` is safe to pass positionally to git; otherwise
 * fail with a BAD_REQUEST without spawning anything.
 */
export function withSafeGitRef<T>(
  ref: string,
  label: string,
  run: () => ResultAsync<T, DomainError>,
): ResultAsync<T, DomainError> {
  const safe = requireSafeGitRef(ref, label);
  return safe.isErr() ? errAsync(safe.error) : run();
}
