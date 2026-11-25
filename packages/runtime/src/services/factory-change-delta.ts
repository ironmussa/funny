/**
 * How a pull request's change differs at two commits of its branch (openspec
 * factory-approval-survives-integration, D2): the factory step `change-delta`.
 *
 * The change at a commit is what it adds and removes against the base branch,
 * from where the two split: per file, the added lines and the removed lines,
 * without their positions. The delta of two commits is what one change has
 * that the other lacks. Lines the base brought in are in neither change, so
 * merging the base in, by anyone and whatever conflict it settled, gives a
 * delta of zero when the pull request still adds and removes the same lines.
 *
 * It errs towards a difference: a line the pull request added that the base now
 * has too leaves the later change, and counts.
 *
 * Deterministic and read-only apart from the fetch: no agent, no checkout, no
 * write to the branch.
 */

import { gitNetwork, gitRead } from '@funny/core/git';
import { err, ok, type Result } from 'neverthrow';

export interface ChangeDeltaRequest {
  kind: 'change-delta';
  /** The earlier commit (the one a member approved). */
  from: string;
  /** The later commit (the pull request's head). */
  to: string;
  /** The pull request's base branch. */
  baseBranch: string;
  /** The run's branch, fetched so a commit GitHub made on it is here. */
  branch: string;
  timeoutMs: number;
}

export interface ChangeDeltaResult {
  kind: 'change-delta';
  /** `compared`: the fields below hold. `failed`: nothing could be compared, see `message`. */
  outcome: 'compared' | 'failed';
  /** Whether `to` descends from `from`. When false nothing else was compared. */
  ancestor: boolean;
  /** Lines one change has that the other lacks, over all files. */
  lines: number;
  /** The files whose change differs, with how many lines each (at most `MAX_DELTA_FILES`). */
  files: Array<{ path: string; lines: number }>;
  /** Whether `files` was cut short. */
  filesTruncated: boolean;
  /** Of the files whose change differs, those the change at `from` did not touch. */
  outsideFrom: string[];
  message: string;
}

/** A delta past this many files is no small adjustment: the list stops there. */
const MAX_DELTA_FILES = 200;

/** A file's change: how many times it adds and removes each line. */
interface FileChange {
  added: Map<string, number>;
  removed: Map<string, number>;
}

type Change = Map<string, FileChange>;

const bump = (counts: Map<string, number>, line: string) =>
  counts.set(line, (counts.get(line) ?? 0) + 1);

/** `"a/b c"` (git quotes a path with special characters) or `a/b c`, without its `a/` or `b/`. */
function pathOf(header: string): string | null {
  const raw = header.replace(/\t.*$/, '');
  if (raw === '/dev/null') return null;
  const unquoted = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw;
  return unquoted.replace(/^[ab]\//, '');
}

/** Where the parser is in a diff: the file being read, and whether its hunks started. */
interface ParseState {
  change: Change;
  file: FileChange | null;
  oldPath: string | null;
  blob: string;
  inHunk: boolean;
}

function fileOf(change: Change, path: string): FileChange {
  const existing = change.get(path);
  if (existing) return existing;
  const created: FileChange = { added: new Map(), removed: new Map() };
  change.set(path, created);
  return created;
}

/** A line inside a hunk: content the file adds or removes. */
function readHunkLine(state: ParseState, line: string): void {
  if (!state.file) return;
  if (line.startsWith('+')) bump(state.file.added, line.slice(1));
  else if (line.startsWith('-')) bump(state.file.removed, line.slice(1));
}

/** A binary file counts as one line naming the blob it ends as. */
function readBinary(state: ParseState, line: string): void {
  const named = /^Binary files (.+) and (.+) differ$/.exec(line);
  const path = named ? (pathOf(named[2]!) ?? pathOf(named[1]!)) : null;
  if (!path) return;
  const blob = state.blob.split('..')[1] ?? state.blob;
  bump(fileOf(state.change, path).added, `\0binary ${blob}`);
}

/** What each line of a file's header does, by how it starts. */
const HEADER_LINES: ReadonlyArray<[string, (state: ParseState, line: string) => void]> = [
  [
    'index ',
    (state, line) => {
      state.blob = line.slice('index '.length).split(' ')[0] ?? '';
    },
  ],
  [
    '--- ',
    (state, line) => {
      state.oldPath = pathOf(line.slice(4));
    },
  ],
  [
    '+++ ',
    (state, line) => {
      const path = pathOf(line.slice(4)) ?? state.oldPath;
      if (path) state.file = fileOf(state.change, path);
    },
  ],
  [
    '@@',
    (state) => {
      state.inHunk = state.file !== null;
    },
  ],
  ['Binary files ', readBinary],
];

/**
 * The change a `git diff -U0 --no-renames` describes. A binary file counts as
 * one line naming the blob it ends as, so the same result is the same change.
 * Inside a hunk every line is content, also one that looks like a header.
 */
export function parseChange(diff: string): Change {
  const state: ParseState = {
    change: new Map(),
    file: null,
    oldPath: null,
    blob: '',
    inHunk: false,
  };
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      Object.assign(state, { file: null, oldPath: null, blob: '', inHunk: false });
    } else if (state.inHunk) {
      readHunkLine(state, line);
    } else {
      HEADER_LINES.find(([prefix]) => line.startsWith(prefix))?.[1](state, line);
    }
  }
  return state.change;
}

/** How many entries of `a` are not in `b`, counting repeats. */
function lacking(a: Map<string, number>, b: Map<string, number>): number {
  let total = 0;
  for (const [line, count] of a) total += Math.max(0, count - (b.get(line) ?? 0));
  return total;
}

const EMPTY: FileChange = { added: new Map(), removed: new Map() };

/** Per file, the lines one change has that the other lacks; files that are the same are left out. */
export function deltaOf(from: Change, to: Change): Array<{ path: string; lines: number }> {
  const paths = new Set([...from.keys(), ...to.keys()]);
  const delta: Array<{ path: string; lines: number }> = [];
  for (const path of paths) {
    const a = from.get(path) ?? EMPTY;
    const b = to.get(path) ?? EMPTY;
    const lines =
      lacking(a.added, b.added) +
      lacking(b.added, a.added) +
      lacking(a.removed, b.removed) +
      lacking(b.removed, a.removed);
    if (lines > 0) delta.push({ path, lines });
  }
  return delta.sort((x, y) => y.lines - x.lines || x.path.localeCompare(y.path));
}

const SHA = /^[0-9a-f]{7,64}$/;

/** The change of `commit` against `base`, from where they split. */
async function changeAt(
  cwd: string,
  commit: string,
  base: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<Result<Change, string>> {
  const fork = await gitRead(['merge-base', commit, base], { cwd, env, reject: false, signal });
  const forkSha = fork.stdout.trim().split('\n')[0] ?? '';
  if (fork.exitCode !== 0 || !forkSha) {
    return err(`${commit} and ${base} have no common commit here.`);
  }
  const diff = await gitRead(
    [
      '-c',
      'core.quotePath=false',
      'diff',
      '--no-color',
      '--no-renames',
      '--no-ext-diff',
      '--no-textconv',
      '-U0',
      forkSha,
      commit,
    ],
    { cwd, env, reject: false, signal },
  );
  if (diff.exitCode !== 0) return err(`Could not read the change at ${commit}.`);
  return ok(parseChange(diff.stdout));
}

/** Compare the pull request's change at `request.from` and at `request.to` in the checkout `cwd`. */
export async function changeDelta(
  cwd: string,
  request: ChangeDeltaRequest,
  signal: AbortSignal,
  env: Record<string, string>,
): Promise<Result<Omit<ChangeDeltaResult, 'kind' | 'outcome' | 'message'>, string>> {
  if (!SHA.test(request.from) || !SHA.test(request.to)) return err('A commit id is not valid.');
  const base = `origin/${request.baseBranch}`;
  // The later commit may be one GitHub made on the branch: bring both refs here.
  const fetched = await gitNetwork(['fetch', 'origin', request.baseBranch, request.branch], {
    cwd,
    env,
    reject: false,
  });
  if (fetched.exitCode !== 0) return err(`Could not fetch ${base}: ${fetched.stderr.trim()}`);
  for (const commit of [request.from, request.to]) {
    const exists = await gitRead(['cat-file', '-e', `${commit}^{commit}`], {
      cwd,
      env,
      reject: false,
    });
    if (exists.exitCode !== 0) return err(`Commit ${commit} is not in this checkout.`);
  }
  const descends = await gitRead(['merge-base', '--is-ancestor', request.from, request.to], {
    cwd,
    env,
    reject: false,
  });
  if (descends.exitCode !== 0 && descends.exitCode !== 1) {
    return err(`Could not compare ${request.from} and ${request.to}.`);
  }
  if (descends.exitCode === 1) {
    return ok({ ancestor: false, lines: 0, files: [], filesTruncated: false, outsideFrom: [] });
  }
  const from = await changeAt(cwd, request.from, base, env, signal);
  if (from.isErr()) return err(from.error);
  const to = await changeAt(cwd, request.to, base, env, signal);
  if (to.isErr()) return err(to.error);
  const delta = deltaOf(from.value, to.value);
  return ok({
    ancestor: true,
    lines: delta.reduce((total, file) => total + file.lines, 0),
    files: delta.slice(0, MAX_DELTA_FILES),
    filesTruncated: delta.length > MAX_DELTA_FILES,
    outsideFrom: delta
      .filter((file) => !from.value.has(file.path))
      .slice(0, MAX_DELTA_FILES)
      .map((file) => file.path),
  });
}
