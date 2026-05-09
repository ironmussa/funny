/**
 * Staging operations: stage, unstage, revert, gitignore.
 */

import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';

import type { DomainError } from '@funny/shared/errors';
import { internal } from '@funny/shared/errors';
import { ok, err, ResultAsync, type Result } from 'neverthrow';

import { git } from './base.js';
import { toDomainError } from './errors.js';
import { getNativeGit } from './native.js';
import { gitRead, gitWrite } from './process.js';

/**
 * Stage files for commit.
 * Filters out gitignored files before running `git add` to prevent
 * the entire operation from failing when ignored files are included.
 */
export function stageFiles(cwd: string, paths: string[]): ResultAsync<void, DomainError> {
  if (paths.length === 0) return new ResultAsync(Promise.resolve(ok(undefined)));

  return ResultAsync.fromPromise(
    (async () => {
      const native = getNativeGit();
      let ignoredSet: Set<string>;

      // Native check_ignore reads .gitignore / info/exclude / core.excludesFile
      // through gix in-process — replaces the `git check-ignore --stdin` spawn.
      let usedNative = false;
      if (native) {
        try {
          const ignored = await native.checkIgnore(cwd, paths);
          ignoredSet = new Set(ignored);
          usedNative = true;
        } catch {
          ignoredSet = new Set();
        }
      } else {
        ignoredSet = new Set();
      }

      if (!usedNative) {
        const checkResult = await gitRead(['check-ignore', '--stdin'], {
          cwd,
          reject: false,
          stdin: paths.join('\n'),
        });
        ignoredSet =
          checkResult.exitCode === 0 && checkResult.stdout.trim()
            ? new Set(
                checkResult.stdout
                  .trim()
                  .split('\n')
                  .map((p) => p.trim()),
              )
            : new Set();
      }

      const filteredPaths = paths.filter((p) => !ignoredSet.has(p));
      if (filteredPaths.length === 0) return;

      const addResult = await git(['add', ...filteredPaths], cwd);
      if (addResult.isErr()) throw addResult.error;
    })(),
    toDomainError,
  );
}

/**
 * Stage a partial diff (selected lines/hunks) via `git apply --cached`.
 * The caller must supply a valid unified-diff patch string.
 */
export function stagePatch(cwd: string, patch: string): ResultAsync<void, DomainError> {
  if (!patch.trim()) return new ResultAsync(Promise.resolve(ok(undefined)));

  return ResultAsync.fromPromise(
    (async () => {
      const result = await gitWrite(['apply', '--cached', '--recount', '--allow-empty', '-'], {
        cwd,
        stdin: patch,
        reject: false,
      });
      if (result.exitCode !== 0) {
        throw new Error(`git apply failed: ${result.stderr || result.stdout}`);
      }
    })(),
    toDomainError,
  );
}

/**
 * Unstage a partial diff (selected lines/hunks) via `git apply --cached --reverse`.
 */
export function unstagePatch(cwd: string, patch: string): ResultAsync<void, DomainError> {
  if (!patch.trim()) return new ResultAsync(Promise.resolve(ok(undefined)));

  return ResultAsync.fromPromise(
    (async () => {
      const result = await gitWrite(
        ['apply', '--cached', '--recount', '--allow-empty', '--reverse', '-'],
        {
          cwd,
          stdin: patch,
          reject: false,
        },
      );
      if (result.exitCode !== 0) {
        throw new Error(`git apply --reverse failed: ${result.stderr || result.stdout}`);
      }
    })(),
    toDomainError,
  );
}

/**
 * Unstage files — batched into a single git command.
 */
export function unstageFiles(cwd: string, paths: string[]): ResultAsync<void, DomainError> {
  if (paths.length === 0) return new ResultAsync(Promise.resolve(ok(undefined)));

  return git(['restore', '--staged', '--', ...paths], cwd).map(() => undefined);
}

/**
 * Revert changes to files.
 * For tracked files, restores to HEAD via `git checkout`.
 * For untracked files, deletes them from the working tree.
 */
export function revertFiles(cwd: string, paths: string[]): ResultAsync<void, DomainError> {
  if (paths.length === 0) return new ResultAsync(Promise.resolve(ok(undefined)));

  return ResultAsync.fromPromise(
    (async () => {
      const native = getNativeGit();

      // Identify untracked files so we can handle them differently
      const untrackedResult = await gitRead(['ls-files', '--others', '--exclude-standard'], {
        cwd,
      });
      const untrackedSet = new Set(
        untrackedResult.stdout
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean),
      );

      // Identify unmerged files (merge conflicts) — these need special handling.
      // Native list_unmerged_files scans index entries with stage > 0 in-process;
      // CLI fallback parses `git ls-files --unmerged` ("<mode> <hash> <stage>\t<path>").
      let unmergedSet: Set<string>;
      let usedNativeUnmerged = false;
      if (native) {
        try {
          const unmerged = await native.listUnmergedFiles(cwd);
          unmergedSet = new Set(unmerged);
          usedNativeUnmerged = true;
        } catch {
          unmergedSet = new Set();
        }
      } else {
        unmergedSet = new Set();
      }
      if (!usedNativeUnmerged) {
        const unmergedResult = await gitRead(['ls-files', '--unmerged'], { cwd });
        unmergedSet = new Set(
          unmergedResult.stdout
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => l.split('\t').pop() ?? ''),
        );
      }

      for (const path of paths) {
        if (untrackedSet.has(path)) {
          // Untracked file: delete it (there's no git version to restore)
          const fullPath = join(cwd, path);
          if (existsSync(fullPath)) rmSync(fullPath);
        } else if (unmergedSet.has(path)) {
          // Unmerged file (merge conflict): check if file exists in HEAD to decide strategy
          const fullPath = join(cwd, path);
          const headCheck = await gitRead(['cat-file', '-e', `HEAD:${path}`], {
            cwd,
            reject: false,
          });
          const existsInHead = headCheck.exitCode === 0;

          if (existsInHead) {
            // File exists in HEAD — restore to HEAD version, resolving the conflict
            const result = await git(['checkout', 'HEAD', '--', path], cwd);
            if (result.isErr()) throw result.error;
          } else {
            // File is new (only from the merge/incoming branch) — remove from index and disk
            await git(['rm', '--cached', '--force', '--', path], cwd);
            if (existsSync(fullPath)) rmSync(fullPath);
          }
        } else {
          const result = await git(['checkout', '--', path], cwd);
          if (result.isErr()) throw result.error;
        }
      }
    })(),
    toDomainError,
  );
}

/**
 * Resolve a specific conflict block in a file.
 * Reads the file, finds the Nth conflict block, applies the resolution, and writes back.
 * If no conflicts remain after resolution, stages the file with `git add`.
 */
export function resolveFileConflict(
  cwd: string,
  filePath: string,
  blockIndex: number,
  resolution: 'ours' | 'theirs' | 'both',
): ResultAsync<{ remainingConflicts: number }, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const fullPath = join(cwd, filePath);
      if (!existsSync(fullPath)) {
        throw new Error(`File not found: ${filePath}`);
      }

      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');

      // Find all conflict blocks
      const MARKER_START = /^<{7}\s?/;
      const MARKER_SEP = /^={7}$/;
      const MARKER_END = /^>{7}\s?/;

      interface Block {
        startLine: number;
        sepLine: number;
        endLine: number;
      }

      const blocks: Block[] = [];
      let i = 0;

      while (i < lines.length) {
        if (MARKER_START.test(lines[i])) {
          const startLine = i;
          let sepLine = -1;
          let endLine = -1;

          for (let j = startLine + 1; j < lines.length; j++) {
            if (MARKER_SEP.test(lines[j]) && sepLine === -1) {
              sepLine = j;
            } else if (sepLine !== -1 && MARKER_END.test(lines[j])) {
              endLine = j;
              break;
            }
          }

          if (sepLine !== -1 && endLine !== -1) {
            blocks.push({ startLine, sepLine, endLine });
            i = endLine + 1;
            continue;
          }
        }
        i++;
      }

      if (blockIndex < 0 || blockIndex >= blocks.length) {
        throw new Error(
          `Conflict block ${blockIndex} not found (file has ${blocks.length} conflict${blocks.length === 1 ? '' : 's'})`,
        );
      }

      const block = blocks[blockIndex];
      const oursLines = lines.slice(block.startLine + 1, block.sepLine);
      const theirsLines = lines.slice(block.sepLine + 1, block.endLine);

      let replacement: string[];
      switch (resolution) {
        case 'ours':
          replacement = oursLines;
          break;
        case 'theirs':
          replacement = theirsLines;
          break;
        case 'both':
          replacement = [...oursLines, ...theirsLines];
          break;
      }

      // Replace the conflict block (startLine through endLine inclusive) with the resolution
      const resolved = [
        ...lines.slice(0, block.startLine),
        ...replacement,
        ...lines.slice(block.endLine + 1),
      ];

      writeFileSync(fullPath, resolved.join('\n'), 'utf-8');

      // Count remaining conflicts in the resolved content
      const remainingConflicts = blocks.length - 1;

      // If no conflicts remain, stage the file
      if (remainingConflicts === 0) {
        const addResult = await git(['add', '--', filePath], cwd);
        if (addResult.isErr()) throw addResult.error;
      }

      return { remainingConflicts };
    })(),
    toDomainError,
  );
}

/**
 * Add a pattern to .gitignore. Creates the file if it doesn't exist.
 * Avoids adding duplicate entries.
 */
export function addToGitignore(cwd: string, pattern: string): Result<void, DomainError> {
  try {
    const gitignorePath = join(cwd, '.gitignore');
    let content = '';
    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, 'utf-8');
    }
    const lines = content.split('\n');
    if (lines.some((l) => l.trim() === pattern.trim())) {
      return ok(undefined);
    }
    const newContent =
      content.endsWith('\n') || content === ''
        ? content + pattern + '\n'
        : content + '\n' + pattern + '\n';
    writeFileSync(gitignorePath, newContent, 'utf-8');
    return ok(undefined);
  } catch (e) {
    return err(internal(`Failed to update .gitignore: ${String(e)}`));
  }
}
