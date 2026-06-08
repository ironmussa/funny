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
  /** Subject line (first line of the commit message). */
  message: string;
  /** Body text after the subject (blank line separator). Empty when none. */
  body: string;
}

/**
 * A commit log entry enriched with the topology data needed to render a branch
 * graph: parent hashes (the edges) and ref decorations (branch/tag labels).
 * Kept separate from {@link GitLogEntry} so the existing flat History view's
 * data path stays untouched.
 */
/**
 * How a {@link GraphRef} relates to the repo: a local branch (`refs/heads/*`),
 * a remote-tracking branch (`refs/remotes/*`), or a tag (`refs/tags/*`).
 * Classified server-side from `git log --decorate=full` so the UI never has to
 * guess local-vs-remote from the `origin/` naming convention (branch names can
 * themselves contain `/`, making prefix-guessing ambiguous).
 */
export type GraphRefKind = 'local' | 'remote' | 'tag';

/** A single branch/tag decoration on a commit, with its origin classified. */
export interface GraphRef {
  /**
   * Display name: bare branch (`main`, `feat/x`), remote-qualified (`origin/main`),
   * tag name (`v1.0`), or the literal `HEAD` for a detached head.
   */
  name: string;
  kind: GraphRefKind;
}

export interface GitGraphLogEntry extends GitLogEntry {
  /** Parent commit hashes. 0 = root, 1 = normal, 2+ = merge commit. */
  parentHashes: string[];
  /**
   * Branch/tag refs decorating this commit, each tagged with its {@link GraphRefKind}.
   * The redundant symbolic refs `HEAD` and `origin/HEAD` are stripped — `HEAD`
   * just points at the checked-out branch (see {@link headBranch}) and
   * `origin/HEAD` only names the remote default. A detached HEAD keeps a literal
   * `HEAD` entry (kind `local`). Empty when no ref decorates.
   */
  refs: GraphRef[];
  /**
   * The checked-out branch, set only on the commit that `HEAD` points at (null
   * on every other commit and when HEAD is detached). Lets the UI highlight the
   * current branch instead of rendering a separate `HEAD` chip.
   */
  headBranch: string | null;
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
          body: e.body ?? '',
        }));
      })(),
      (error) => processError(String(error), 1, ''),
    );
  }
  // Field/record separators so multi-line commit bodies do not break parsing.
  const FIELD_SEP = '\x1f';
  const RECORD_SEP = '\x1e';
  const format = `%H%x1F%h%x1F%an%x1F%ae%x1F%ar%x1F%s%x1F%b%x1E`;
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
        .split(RECORD_SEP)
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record) => {
          const [hash, shortHash, author, authorEmail, relativeDate, message, body = ''] =
            record.split(FIELD_SEP);
          return {
            hash,
            shortHash,
            author,
            authorEmail,
            relativeDate,
            message,
            body: body.trim(),
          };
        });
    })(),
    (error) => processError(String(error), 1, ''),
  );
}

/**
 * Parse a `git log --decorate=full %D` decoration string into classified refs
 * plus the current branch. `--decorate=full` keeps the full ref paths
 * (`refs/heads/*`, `refs/remotes/*`, `refs/tags/*`) so each ref's
 * {@link GraphRefKind} is unambiguous — unlike the short form, where a local
 * branch named `feat/x` is indistinguishable from a remote `origin/x`.
 *
 * Drops the two redundant symbolic refs: `HEAD` (replaced by `headBranch`, which
 * the UI highlights) and remote default pointers ending in `/HEAD` such as
 * `refs/remotes/origin/HEAD` (pure noise in a graph). A detached HEAD — the bare
 * token `HEAD` with no arrow — keeps its `HEAD` chip since there's no branch to
 * point at.
 *
 * e.g. `HEAD -> refs/heads/main, refs/remotes/origin/main, refs/remotes/origin/HEAD, tag: refs/tags/v1.0`
 *   → `{ refs: [{name:'main',kind:'local'}, {name:'origin/main',kind:'remote'}, {name:'v1.0',kind:'tag'}], headBranch: 'main' }`
 */
function parseRefs(decoration: string): { refs: GraphRef[]; headBranch: string | null } {
  const trimmed = decoration.trim();
  if (!trimmed) return { refs: [], headBranch: null };
  const refs: GraphRef[] = [];
  let headBranch: string | null = null;
  const stripHeads = (full: string) => full.replace(/^refs\/heads\//, '');
  for (const raw of trimmed.split(',')) {
    const token = raw.trim();
    if (!token) continue;
    if (token.startsWith('HEAD -> ')) {
      // Current branch — record it and emit only the branch chip (drop `HEAD`).
      headBranch = stripHeads(token.slice('HEAD -> '.length).trim());
      refs.push({ name: headBranch, kind: 'local' });
    } else if (token === 'HEAD') {
      // Detached HEAD: no branch to highlight, keep the literal chip.
      refs.push({ name: 'HEAD', kind: 'local' });
    } else if (token.startsWith('tag: ')) {
      refs.push({ name: token.slice('tag: refs/tags/'.length).trim(), kind: 'tag' });
    } else if (token.startsWith('refs/remotes/')) {
      const name = token.slice('refs/remotes/'.length).trim();
      // Remote default-branch pointer (e.g. `origin/HEAD`) — redundant, drop it.
      if (name.endsWith('/HEAD')) continue;
      refs.push({ name, kind: 'remote' });
    } else if (token.startsWith('refs/heads/')) {
      refs.push({ name: stripHeads(token), kind: 'local' });
    } else {
      // Fallback for any decoration we didn't anticipate — treat as a local chip.
      refs.push({ name: token, kind: 'local' });
    }
  }
  return { refs, headBranch };
}

/**
 * Get commit log entries enriched with parent hashes and ref decorations for
 * rendering a branch graph. Ordered by commit date (`--date-order`) to match
 * GitKraken: commits sort by timestamp, so a newer side-branch commit can sit
 * above an older master commit and master commits interleave between a branch's
 * commits (rather than the branch staying one contiguous block as `--topo-order`
 * would force). `--date-order` still never shows a parent before all of its
 * children, the one invariant the lane layout (`computeGraphRows`) requires.
 * When `all` is set, walks every ref (`--all`) so divergent / unmerged branches
 * appear; otherwise walks HEAD only. Bypasses the native fast-path (which
 * doesn't return parents or refs) and goes straight to `git log`.
 */
export function getGraphLog(
  cwd: string,
  opts: { limit?: number; skip?: number; all?: boolean } = {},
): ResultAsync<GitGraphLogEntry[], DomainError> {
  const { limit = 50, skip = 0, all = false } = opts;
  const FIELD_SEP = '\x1f';
  const RECORD_SEP = '\x1e';
  // hash, shortHash, author, email, relDate, parents (space-sep), refs (%D), subject, body
  const format = `%H%x1F%h%x1F%an%x1F%ae%x1F%ar%x1F%P%x1F%D%x1F%s%x1F%b%x1E`;
  // `--decorate=full` keeps full ref paths in `%D` so parseRefs can classify
  // each ref as local/remote/tag without guessing from the `origin/` convention.
  const args = [
    'log',
    '--date-order',
    '--decorate=full',
    `--format=${format}`,
    '-n',
    String(limit),
  ];
  if (skip > 0) args.push(`--skip=${skip}`);
  if (all) args.push('--all');
  return ResultAsync.fromPromise(
    (async () => {
      const result = await gitRead(args, { cwd, reject: false });
      // Empty repo (no commits yet) returns exit code 128 — treat as empty log
      if (result.exitCode !== 0 || !result.stdout.trim()) return [];
      return result.stdout
        .split(RECORD_SEP)
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record) => {
          const [
            hash,
            shortHash,
            author,
            authorEmail,
            relativeDate,
            parents = '',
            refs = '',
            message,
            body = '',
          ] = record.split(FIELD_SEP);
          const { refs: refNames, headBranch } = parseRefs(refs);
          return {
            hash,
            shortHash,
            author,
            authorEmail,
            relativeDate,
            message,
            body: body.trim(),
            parentHashes: parents.trim() ? parents.trim().split(' ').filter(Boolean) : [],
            refs: refNames,
            headBranch,
          };
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
