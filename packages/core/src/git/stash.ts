/**
 * Stash operations and soft reset.
 */

import { processError, internal, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { git } from './base.js';
import { getNativeGit } from './native.js';
import { gitRead } from './process.js';

// ─── Types ──────────────────────────────────────────────

export interface StashEntry {
  index: string;
  message: string;
  relativeDate: string;
}

// ─── Public API ─────────────────────────────────────────

/**
 * Stash current changes (all files).
 */
export function stash(cwd: string): ResultAsync<string, DomainError> {
  return git(['stash', 'push', '-m', 'funny: stashed changes'], cwd);
}

/**
 * Stash specific files only.
 */
export function stashFiles(cwd: string, files: string[]): ResultAsync<string, DomainError> {
  return git(['stash', 'push', '-m', 'funny: stashed changes', '--', ...files], cwd);
}

/**
 * Pop the most recent stash.
 */
export function stashPop(cwd: string): ResultAsync<string, DomainError> {
  return git(['stash', 'pop'], cwd);
}

/**
 * Drop a specific stash entry (defaults to stash@{0}).
 */
export function stashDrop(cwd: string, stashRef = 'stash@{0}'): ResultAsync<string, DomainError> {
  return git(['stash', 'drop', stashRef], cwd);
}

/**
 * List stash entries.
 * Uses @@SEP@@ delimiter to avoid corruption when stash messages contain pipes.
 */
export function stashList(cwd: string): ResultAsync<StashEntry[], DomainError> {
  const native = getNativeGit();
  if (native) {
    return ResultAsync.fromPromise(native.getStashList(cwd), (error) => internal(String(error)));
  }
  const SEP = '@@SEP@@';
  return ResultAsync.fromPromise(
    (async () => {
      const result = await gitRead(['stash', 'list', `--format=%gd${SEP}%gs${SEP}%ar`], {
        cwd,
        reject: false,
      });
      if (result.exitCode !== 0 || !result.stdout.trim()) return [];
      return result.stdout
        .trim()
        .split('\n')
        .map((line) => {
          const [index, message, relativeDate] = line.split(SEP);
          return { index: index || '', message: message || '', relativeDate: relativeDate || '' };
        });
    })(),
    (error) => internal(String(error)),
  );
}

/**
 * Show files changed in a specific stash entry.
 */
export function stashShow(
  cwd: string,
  stashRef = 'stash@{0}',
): ResultAsync<Array<{ path: string; additions: number; deletions: number }>, DomainError> {
  const native = getNativeGit();
  if (native) {
    return ResultAsync.fromPromise(native.getStashShow(cwd, stashRef), (error) =>
      internal(String(error)),
    );
  }
  return ResultAsync.fromPromise(
    (async () => {
      const result = await gitRead(['stash', 'show', '--numstat', stashRef], {
        cwd,
        reject: false,
      });
      if (result.exitCode !== 0 || !result.stdout.trim()) return [];
      return result.stdout
        .trim()
        .split('\n')
        .map((line) => {
          const [add, del, ...rest] = line.split('\t');
          return {
            path: rest.join('\t'),
            additions: parseInt(add, 10) || 0,
            deletions: parseInt(del, 10) || 0,
          };
        });
    })(),
    (error) => internal(String(error)),
  );
}

/**
 * Get the diff for a single file within a stash entry.
 */
export function stashFileDiff(
  cwd: string,
  stashRef: string,
  filePath: string,
): ResultAsync<string, DomainError> {
  const native = getNativeGit();
  if (native) {
    return ResultAsync.fromPromise(native.getStashFileDiff(cwd, stashRef, filePath), (error) =>
      internal(String(error)),
    );
  }
  return ResultAsync.fromPromise(
    (async () => {
      const result = await gitRead(['stash', 'show', '-p', stashRef, '--', filePath], {
        cwd,
        reject: false,
      });
      return result.exitCode === 0 ? result.stdout : '';
    })(),
    (error) => internal(String(error)),
  );
}

// ─── Reset Soft ─────────────────────────────────────────

/**
 * Undo the last commit, keeping changes staged.
 */
export function resetSoft(cwd: string): ResultAsync<string, DomainError> {
  const native = getNativeGit();
  if (native) {
    return ResultAsync.fromPromise(
      native.resetSoft(cwd).then(() => ''),
      (error) => processError(String(error), 1, ''),
    );
  }
  return git(['reset', '--soft', 'HEAD~1'], cwd);
}
