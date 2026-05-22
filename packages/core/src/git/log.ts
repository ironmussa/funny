/**
 * Commit log and commit detail operations.
 */

import { processError, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { getNativeGit } from './native.js';
import { gitRead } from './process.js';

// ─── Types ──────────────────────────────────────────────

export interface GitLogEntry {
  hash: string;
  shortHash: string;
  author: string;
  authorEmail: string;
  relativeDate: string;
  message: string;
}

export interface CommitFileEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied';
  additions: number;
  deletions: number;
}

const STATUS_MAP: Record<string, CommitFileEntry['status']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
};

// ─── Public API ─────────────────────────────────────────

/**
 * Get recent commit log entries.
 * When baseBranch is provided, only shows commits in HEAD that are not in baseBranch
 * (i.e. `git log baseBranch..HEAD`), which is useful for worktree branches.
 */
export function getLog(
  cwd: string,
  limit = 20,
  baseBranch?: string | null,
  skip = 0,
): ResultAsync<GitLogEntry[], DomainError> {
  const native = getNativeGit();
  if (native && !baseBranch && skip === 0) {
    return ResultAsync.fromPromise(
      (async () => {
        const [entries, emailMap] = await Promise.all([
          native.getLog(cwd, limit).catch(() => []),
          fetchEmailMap(cwd, limit, undefined, 0),
        ]);
        return entries.map((e) => ({
          hash: e.hash,
          shortHash: e.shortHash,
          author: e.author,
          authorEmail: emailMap.get(e.hash) ?? '',
          relativeDate: e.relativeDate,
          message: e.message,
        }));
      })(),
      (error) => processError(String(error), 1, ''),
    );
  }
  const SEP = '@@SEP@@';
  const format = `%H${SEP}%h${SEP}%an${SEP}%ae${SEP}%ar${SEP}%s`;
  const args = ['log', `--format=${format}`, `-n`, String(limit)];
  if (skip > 0) {
    args.push(`--skip=${skip}`);
  }
  if (baseBranch) {
    args.push(`${baseBranch}..HEAD`);
  }
  return ResultAsync.fromPromise(
    (async () => {
      const result = await gitRead(args, { cwd, reject: false });
      // Empty repo (no commits yet) returns exit code 128 — treat as empty log
      if (result.exitCode !== 0 || !result.stdout.trim()) return [];
      return result.stdout
        .trim()
        .split('\n')
        .map((line) => {
          const [hash, shortHash, author, authorEmail, relativeDate, message] = line.split(SEP);
          return { hash, shortHash, author, authorEmail, relativeDate, message };
        });
    })(),
    (error) => processError(String(error), 1, ''),
  );
}

async function fetchEmailMap(
  cwd: string,
  limit: number,
  baseBranch: string | null | undefined,
  skip: number,
): Promise<Map<string, string>> {
  const SEP = '@@SEP@@';
  const args = ['log', `--format=%H${SEP}%ae`, '-n', String(limit)];
  if (skip > 0) args.push(`--skip=${skip}`);
  if (baseBranch) args.push(`${baseBranch}..HEAD`);
  const result = await gitRead(args, { cwd, reject: false });
  const map = new Map<string, string>();
  if (result.exitCode !== 0 || !result.stdout.trim()) return map;
  for (const line of result.stdout.trim().split('\n')) {
    const [hash, email] = line.split(SEP);
    if (hash) map.set(hash, email ?? '');
  }
  return map;
}

/**
 * Get the set of commit hashes that exist locally but not on any remote.
 * Useful for marking unpushed commits in the log UI.
 */
export function getUnpushedHashes(cwd: string): ResultAsync<Set<string>, DomainError> {
  const native = getNativeGit();
  if (native) {
    return ResultAsync.fromPromise(
      native.getUnpushedHashes(cwd).then((hashes) => new Set(hashes)),
      (error) => processError(String(error), 1, ''),
    );
  }
  return ResultAsync.fromPromise(
    (async () => {
      const result = await gitRead(['rev-list', 'HEAD', '--not', '--remotes'], {
        cwd,
        reject: false,
      });
      if (result.exitCode !== 0 || !result.stdout.trim()) return new Set<string>();
      return new Set(result.stdout.trim().split('\n'));
    })(),
    (error) => processError(String(error), 1, ''),
  );
}

/**
 * Get the full commit message body (everything after the subject line) for a single commit.
 */
export function getCommitBody(cwd: string, hash: string): ResultAsync<string, DomainError> {
  const native = getNativeGit();
  if (native) {
    return ResultAsync.fromPromise(native.getCommitBody(cwd, hash), (error) =>
      processError(String(error), 1, ''),
    );
  }
  return ResultAsync.fromPromise(
    (async () => {
      const result = await gitRead(['log', '-1', '--format=%b', hash], {
        cwd,
        reject: false,
      });
      if (result.exitCode !== 0) return '';
      return result.stdout.trim();
    })(),
    (error) => processError(String(error), 1, ''),
  );
}

/**
 * Get changed files for a specific commit (file list + line stats).
 */
export function getCommitFiles(
  cwd: string,
  hash: string,
): ResultAsync<CommitFileEntry[], DomainError> {
  const native = getNativeGit();
  if (native) {
    return ResultAsync.fromPromise(
      native.getCommitFiles(cwd, hash).then((files) =>
        files.map((f) => ({
          path: f.path,
          status: (f.status as CommitFileEntry['status']) || 'modified',
          additions: f.additions,
          deletions: f.deletions,
        })),
      ),
      (error) => processError(String(error), 1, ''),
    );
  }
  return ResultAsync.fromPromise(
    (async () => {
      // Run both commands in parallel
      const [nameStatusResult, numstatResult] = await Promise.all([
        gitRead(['diff-tree', '--no-commit-id', '-r', '--name-status', hash], {
          cwd,
          reject: false,
        }),
        gitRead(['diff-tree', '--no-commit-id', '-r', '--numstat', hash], {
          cwd,
          reject: false,
        }),
      ]);

      if (nameStatusResult.exitCode !== 0) return [];

      // Parse numstat into a map: path → { additions, deletions }
      const statMap = new Map<string, { additions: number; deletions: number }>();
      if (numstatResult.exitCode === 0 && numstatResult.stdout.trim()) {
        for (const line of numstatResult.stdout.trim().split('\n')) {
          const parts = line.split('\t');
          if (parts.length >= 3) {
            const additions = parts[0] === '-' ? 0 : parseInt(parts[0], 10) || 0;
            const deletions = parts[1] === '-' ? 0 : parseInt(parts[1], 10) || 0;
            const path = parts.slice(2).join('\t'); // handle paths with tabs
            statMap.set(path, { additions, deletions });
          }
        }
      }

      // Parse name-status
      const files: CommitFileEntry[] = [];
      for (const line of nameStatusResult.stdout.trim().split('\n')) {
        if (!line) continue;
        const parts = line.split('\t');
        if (parts.length < 2) continue;
        const statusChar = parts[0][0]; // R100 → R, etc.
        const status = STATUS_MAP[statusChar] || 'modified';
        // For renames/copies, use the destination path (parts[2])
        const path =
          parts.length >= 3 && (statusChar === 'R' || statusChar === 'C') ? parts[2] : parts[1];
        const stats = statMap.get(path) || { additions: 0, deletions: 0 };
        files.push({ path, status, ...stats });
      }
      return files;
    })(),
    (error) => processError(String(error), 1, ''),
  );
}

/**
 * Get the diff for a single file within a specific commit.
 */
export function getCommitFileDiff(
  cwd: string,
  hash: string,
  filePath: string,
): ResultAsync<string, DomainError> {
  const native = getNativeGit();
  if (native) {
    return ResultAsync.fromPromise(native.getCommitFileDiff(cwd, hash, filePath), (error) =>
      processError(String(error), 1, ''),
    );
  }
  return ResultAsync.fromPromise(
    (async () => {
      const result = await gitRead(['diff-tree', '-p', '--no-commit-id', hash, '--', filePath], {
        cwd,
        reject: false,
      });
      return result.exitCode === 0 ? result.stdout : '';
    })(),
    (error) => processError(String(error), 1, ''),
  );
}
