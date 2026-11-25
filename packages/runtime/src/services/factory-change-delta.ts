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
 * A file the earlier change did not touch is "brought by the base" when the
 * base changed it between the two commits' fork points and the later change
 * removes from it only lines the base added (openspec
 * factory-approval-follows-base-code, D1): the implementer fixed the base's new
 * code. An edit that left a file of the earlier change and turns up in such a
 * file moved with its code, and `linesAcrossMoves` does not count it (D2).
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
  /** Of `outsideFrom`, the files the base brought: it changed them, and the change removes only its lines. */
  baseBrought: string[];
  /** `lines`, without the edits that moved into a file the base brought. */
  linesAcrossMoves: number;
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

/** Where `commit` split from `base`. */
async function forkOf(
  cwd: string,
  commit: string,
  base: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<Result<string, string>> {
  const fork = await gitRead(['merge-base', commit, base], { cwd, env, reject: false, signal });
  const forkSha = fork.stdout.trim().split('\n')[0] ?? '';
  if (fork.exitCode !== 0 || !forkSha) {
    return err(`${commit} and ${base} have no common commit here.`);
  }
  return ok(forkSha);
}

/** The change from commit `from` to commit `to`. */
async function changeBetween(
  cwd: string,
  from: string,
  to: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<Result<Change, string>> {
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
      from,
      to,
    ],
    { cwd, env, reject: false, signal },
  );
  if (diff.exitCode !== 0) return err(`Could not read the change at ${to}.`);
  return ok(parseChange(diff.stdout));
}

/** Whether every entry of `a` is in `b`, counting repeats. */
const within = (a: Map<string, number>, b: Map<string, number>) => lacking(a, b) === 0;

/**
 * Of the files only the later change touches, those the base brought (D1): the
 * base changed them between the two fork points, and the later change removes
 * from them only lines the base added there.
 */
function baseBroughtFiles(outside: readonly string[], to: Change, base: Change): string[] {
  return outside.filter((path) => {
    const brought = base.get(path);
    const changed = to.get(path);
    return brought !== undefined && changed !== undefined && within(changed.removed, brought.added);
  });
}

/** Per line, how many times `pick` gives it over `paths`. */
function pooled(
  paths: Iterable<string>,
  pick: (path: string) => Map<string, number>,
): Map<string, number> {
  const pool = new Map<string, number>();
  for (const path of paths) {
    for (const [line, count] of pick(path)) pool.set(line, (pool.get(line) ?? 0) + count);
  }
  return pool;
}

/** How many entries `a` and `b` share, counting repeats. */
function shared(a: Map<string, number>, b: Map<string, number>): number {
  let total = 0;
  for (const [line, count] of a) total += Math.min(count, b.get(line) ?? 0);
  return total;
}

/** Lines in `side` of `of` that `than` lacks, per line. */
function surplus(of: FileChange, than: FileChange, side: keyof FileChange): Map<string, number> {
  const left = new Map<string, number>();
  for (const [line, count] of of[side]) {
    const extra = count - (than[side].get(line) ?? 0);
    if (extra > 0) left.set(line, extra);
  }
  return left;
}

/**
 * How many edits moved (D2): a line the earlier change had in one of its files
 * and the later change lacks there, that the later change has in a file the
 * base brought. Each counts twice in the per-file delta (left one file, joined
 * another). Only moves into files the base brought pair, never between two
 * files of the earlier change.
 */
function movedLines(from: Change, to: Change, brought: readonly string[]): number {
  const fileAt = (change: Change, path: string) => change.get(path) ?? EMPTY;
  let moved = 0;
  for (const side of ['added', 'removed'] as const) {
    const lost = pooled(from.keys(), (path) => surplus(fileAt(from, path), fileAt(to, path), side));
    const gained = pooled(brought, (path) => fileAt(to, path)[side]);
    moved += shared(lost, gained);
  }
  return moved;
}

/** The change of `commit` against `base`, from where they split, and that fork point. */
async function changeAt(
  cwd: string,
  commit: string,
  base: string,
  env: Record<string, string>,
  signal: AbortSignal,
): Promise<Result<{ fork: string; change: Change }, string>> {
  const fork = await forkOf(cwd, commit, base, env, signal);
  if (fork.isErr()) return err(fork.error);
  const change = await changeBetween(cwd, fork.value, commit, env, signal);
  return change.map((value) => ({ fork: fork.value, change: value }));
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
    return ok({ ...NOT_COMPARED });
  }
  const from = await changeAt(cwd, request.from, base, env, signal);
  if (from.isErr()) return err(from.error);
  const to = await changeAt(cwd, request.to, base, env, signal);
  if (to.isErr()) return err(to.error);
  // What the base itself changed between the two fork points (D1).
  const baseChange = await changeBetween(cwd, from.value.fork, to.value.fork, env, signal);
  if (baseChange.isErr()) return err(baseChange.error);
  return ok(compareChanges(from.value.change, to.value.change, baseChange.value));
}

/** The comparison of a descendant commit's change with an earlier one's. */
type Comparison = Omit<ChangeDeltaResult, 'kind' | 'outcome' | 'message'>;

const NOT_COMPARED: Comparison = {
  ancestor: false,
  lines: 0,
  files: [],
  filesTruncated: false,
  outsideFrom: [],
  baseBrought: [],
  linesAcrossMoves: 0,
};

/** Compare the change at `from` with the one at `to`, given what the base changed between them. */
export function compareChanges(from: Change, to: Change, base: Change): Comparison {
  const delta = deltaOf(from, to);
  const lines = delta.reduce((total, file) => total + file.lines, 0);
  const outside = delta.filter((file) => !from.has(file.path)).map((file) => file.path);
  const brought = baseBroughtFiles(outside, to, base);
  return {
    ancestor: true,
    lines,
    files: delta.slice(0, MAX_DELTA_FILES),
    filesTruncated: delta.length > MAX_DELTA_FILES,
    outsideFrom: outside.slice(0, MAX_DELTA_FILES),
    baseBrought: brought.slice(0, MAX_DELTA_FILES),
    linesAcrossMoves: lines - 2 * movedLines(from, to, brought),
  };
}
