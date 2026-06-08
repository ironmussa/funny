/**
 * Blame operations.
 *
 * Backed entirely by the native gitoxide module (`@funny/native-git`). Unlike
 * diff/status there is no CLI fallback: blame is a non-critical, on-open
 * convenience, so when the native module is unavailable we surface an error and
 * the caller simply renders no gutter.
 */

import { processError, internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync, errAsync } from 'neverthrow';

import { getNativeGit, type NativeBlameResult } from './native.js';

export type BlameHunk = NativeBlameResult['hunks'][number];
export type BlameResult = NativeBlameResult;

/**
 * Blame the file at the absolute path `filePath` against HEAD.
 *
 * Returns one entry per contiguous run of same-commit lines (`startLine` is
 * 1-based). `blamedLineCount` is the line count of the HEAD version of the
 * file; lines past it in the working copy are uncommitted. The repository is
 * discovered from the file's directory, so no repo root is required.
 */
export function getBlame(filePath: string): ResultAsync<BlameResult, DomainError> {
  const native = getNativeGit();
  if (!native) {
    return errAsync(internal('Native git module unavailable; blame is not supported'));
  }
  return ResultAsync.fromPromise(native.blameFile(filePath), (error) =>
    processError(String(error), 1, ''),
  );
}
