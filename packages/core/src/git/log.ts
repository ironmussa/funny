/**
 * Commit log and commit detail operations.
 */

import { processError, type DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { getNativeGit } from './native.js';
import { execute, gitRead } from './process.js';

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

export interface GitRebaseReflogStep {
  hash: string;
  shortHash: string;
  selector: string;
  timestamp: string | null;
  action: 'start' | 'finish' | 'pick' | 'continue' | 'abort' | 'other';
  message: string;
  subject: string;
}

export interface GitRebaseCommitPair {
  originalHash: string;
  originalShortHash: string;
  rebasedHash: string;
  rebasedShortHash: string;
  subject: string;
}

export interface GitRebaseReflogEvent {
  id: string;
  kind: 'rebase';
  label: string;
  branch: string | null;
  onto: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  startHash: string | null;
  startShortHash: string | null;
  finishHash: string | null;
  finishShortHash: string | null;
  completed: boolean;
  steps: GitRebaseReflogStep[];
  commitHashes: string[];
  commitPairs: GitRebaseCommitPair[];
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

const REBASE_REFLOG_RE = /^(.*?rebase.*?)\s+\(([^)]+)\):\s*(.*)$/i;

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
function parseRefs(decoration: string): {
  refs: GraphRef[];
  headBranch: string | null;
} {
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
      refs.push({
        name: token.slice('tag: refs/tags/'.length).trim(),
        kind: 'tag',
      });
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
 * rendering a branch graph. Ordered by commit date (`--date-order`) so commits
 * from divergent branches interleave by timestamp — matching GitKraken's
 * default. This is what makes an unmerged side branch read as a long parallel
 * lane (its commits visually alternate with trunk commits row by row) rather
 * than as a compact block stacked above its merge-base, which is what
 * `--topo-order` produces. `--date-order` still never shows a parent before all
 * of its children, the one invariant the lane layout (`computeGraphRows`)
 * needs. When `all` is set, walks every ref (`--all`) so divergent / unmerged
 * branches appear; otherwise walks HEAD only. Bypasses the native fast-path
 * (which doesn't return parents or refs) and goes straight to `git log`.
 */
export function getGraphLog(
  cwd: string,
  opts: { limit?: number; skip?: number; all?: boolean } = {},
): ResultAsync<GitGraphLogEntry[], DomainError> {
  const { limit = 50, skip = 0, all = false } = opts;
  const FIELD_SEP = '\x1f';
  const RECORD_SEP = '\x1e';
  // hash, shortHash, author, email, relDate, parents (space-sep), refs (%D), subject, body.
  // relDate uses the COMMITTER date (%cr), not the author date (%ar): the rows
  // are sorted by `--date-order` (committer timestamp), so showing the committer
  // date keeps each row's displayed "Nm ago" monotonic with its position. With
  // %ar, a rebased/cherry-picked commit (author ≠ committer date) would read as
  // out of order relative to its neighbours.
  const format = `%H%x1F%h%x1F%an%x1F%ae%x1F%cr%x1F%P%x1F%D%x1F%s%x1F%b%x1E`;
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

/**
 * Return rebase operations captured by the local reflog. Reflog is intentionally
 * kept separate from the commit graph: it records local ref movement and expires
 * over time, while the graph records durable commit topology.
 */
export function getRebaseReflogEvents(
  cwd: string,
  opts: { limit?: number } = {},
): ResultAsync<GitRebaseReflogEvent[], DomainError> {
  const { limit = 200 } = opts;
  const FIELD_SEP = '\x1f';
  const RECORD_SEP = '\x1e';
  const format = `%H%x1F%h%x1F%gd%x1F%gs%x1E`;
  return ResultAsync.fromPromise(
    (async () => {
      const result = await gitRead(
        ['log', '-g', '--date=iso-strict', `--format=${format}`, '-n', String(limit)],
        { cwd, reject: false },
      );
      if (result.exitCode !== 0 || !result.stdout.trim()) return [];
      const steps = result.stdout
        .split(RECORD_SEP)
        .map((record) => record.trim())
        .filter(Boolean)
        .map((record) => {
          const [hash, shortHash, selector, subject] = record.split(FIELD_SEP);
          return parseRebaseReflogStep({ hash, shortHash, selector, subject });
        })
        .filter((step): step is GitRebaseReflogStep => step !== null);
      const events = groupRebaseReflogSteps(steps);
      return enrichRebaseEventsWithCommitPairs(cwd, events, limit * 5);
    })(),
    (error) => processError(String(error), 1, ''),
  );
}

function parseRebaseReflogStep(raw: {
  hash: string;
  shortHash: string;
  selector: string;
  subject: string;
}): GitRebaseReflogStep | null {
  const match = REBASE_REFLOG_RE.exec(raw.subject);
  if (!match) return null;
  const action = normalizeRebaseAction(match[2]);
  return {
    hash: raw.hash,
    shortHash: raw.shortHash,
    selector: raw.selector,
    timestamp: parseReflogTimestamp(raw.selector),
    action,
    message: match[3].trim(),
    subject: raw.subject,
  };
}

function normalizeRebaseAction(action: string): GitRebaseReflogStep['action'] {
  const normalized = action.trim().toLowerCase();
  if (
    normalized === 'start' ||
    normalized === 'finish' ||
    normalized === 'pick' ||
    normalized === 'continue' ||
    normalized === 'abort'
  ) {
    return normalized;
  }
  return 'other';
}

function parseReflogTimestamp(selector: string): string | null {
  return selector.match(/@\{(.+)\}$/)?.[1] ?? null;
}

function groupRebaseReflogSteps(stepsNewestFirst: GitRebaseReflogStep[]): GitRebaseReflogEvent[] {
  const events: GitRebaseReflogEvent[] = [];
  let active: GitRebaseReflogStep[] = [];

  for (const step of [...stepsNewestFirst].reverse()) {
    if (step.action === 'start') {
      if (active.length > 0) events.push(buildRebaseEvent(active));
      active = [step];
      continue;
    }

    if (active.length === 0) {
      active = [step];
    } else {
      active.push(step);
    }

    if (step.action === 'finish' || step.action === 'abort') {
      events.push(buildRebaseEvent(active));
      active = [];
    }
  }

  if (active.length > 0) events.push(buildRebaseEvent(active));
  return events.reverse();
}

function buildRebaseEvent(steps: GitRebaseReflogStep[]): GitRebaseReflogEvent {
  const start = steps.find((step) => step.action === 'start') ?? null;
  const finish =
    [...steps].reverse().find((step) => step.action === 'finish' || step.action === 'abort') ??
    null;
  const uniqueCommitHashes = [
    ...new Set(steps.filter((s) => s.action !== 'start').map((s) => s.hash)),
  ];
  const id = `${start?.selector ?? steps[0]?.selector ?? 'rebase'}..${finish?.selector ?? steps.at(-1)?.selector ?? 'open'}`;
  return {
    id,
    kind: 'rebase',
    label: rebaseLabelFor(steps),
    branch: finish ? branchFromFinishMessage(finish.message) : null,
    onto: start ? ontoFromStartMessage(start.message) : null,
    startedAt: start?.timestamp ?? steps[0]?.timestamp ?? null,
    finishedAt: finish?.timestamp ?? null,
    startHash: start?.hash ?? null,
    startShortHash: start?.shortHash ?? null,
    finishHash: finish?.hash ?? null,
    finishShortHash: finish?.shortHash ?? null,
    completed: finish?.action === 'finish',
    steps,
    commitHashes: uniqueCommitHashes,
    commitPairs: [],
  };
}

interface PatchCandidate {
  hash: string;
  shortHash: string;
  subject: string;
}

async function enrichRebaseEventsWithCommitPairs(
  cwd: string,
  events: GitRebaseReflogEvent[],
  candidateLimit: number,
): Promise<GitRebaseReflogEvent[]> {
  if (events.length === 0) return events;

  const eventHashes = new Set(events.flatMap((event) => event.commitHashes));
  const replayedSubjects = new Set(
    events.flatMap((event) =>
      event.steps
        .filter((step) => step.action === 'pick' || step.action === 'continue')
        .map((step) => normalizeSubject(step.message)),
    ),
  );
  const candidates = await getRebasePatchCandidates(cwd, Math.max(candidateLimit, 500));
  const relevantCandidates = candidates.filter(
    (candidate) =>
      eventHashes.has(candidate.hash) || replayedSubjects.has(normalizeSubject(candidate.subject)),
  );
  const candidateByHash = new Map(
    relevantCandidates.map((candidate) => [candidate.hash, candidate]),
  );
  const hashesToFingerprint = new Set<string>([
    ...relevantCandidates.map((candidate) => candidate.hash),
    ...eventHashes,
  ]);
  const patchIdsByHash = await getStablePatchIds(cwd, [...hashesToFingerprint]);
  const candidatesByPatchId = new Map<string, PatchCandidate[]>();
  const candidatesBySubject = new Map<string, PatchCandidate[]>();
  for (const candidate of relevantCandidates) {
    const subjectKey = normalizeSubject(candidate.subject);
    const subjectMatches = candidatesBySubject.get(subjectKey);
    if (subjectMatches) subjectMatches.push(candidate);
    else candidatesBySubject.set(subjectKey, [candidate]);

    const patchId = patchIdsByHash.get(candidate.hash);
    if (!patchId) continue;
    const existing = candidatesByPatchId.get(patchId);
    if (existing) existing.push(candidate);
    else candidatesByPatchId.set(patchId, [candidate]);
  }

  return events.map((event) => ({
    ...event,
    commitPairs: inferCommitPairsForEvent(
      event,
      patchIdsByHash,
      candidatesByPatchId,
      candidatesBySubject,
      candidateByHash,
    ),
  }));
}

async function getRebasePatchCandidates(cwd: string, limit: number): Promise<PatchCandidate[]> {
  const FIELD_SEP = '\x1f';
  const result = await gitRead(
    ['log', '--all', '--reflog', `--format=%H${FIELD_SEP}%h${FIELD_SEP}%s`, '-n', String(limit)],
    { cwd, reject: false },
  );
  if (result.exitCode !== 0 || !result.stdout.trim()) return [];
  const byHash = new Map<string, PatchCandidate>();
  for (const line of result.stdout.split('\n')) {
    const [hash, shortHash, subject] = line.split(FIELD_SEP);
    if (!hash || byHash.has(hash)) continue;
    byHash.set(hash, { hash, shortHash, subject });
  }
  return [...byHash.values()];
}

async function getStablePatchIds(cwd: string, hashes: string[]): Promise<Map<string, string>> {
  if (hashes.length === 0) return new Map();
  const result = await gitRead(['show', '--pretty=format:commit %H', '--patch', ...hashes], {
    cwd,
    reject: false,
    maxOutputBytes: 20 * 1024 * 1024,
  });
  if (result.exitCode !== 0 || !result.stdout.trim()) return new Map();
  const patchIdResult = await execute('git', ['patch-id', '--stable'], {
    cwd,
    stdin: result.stdout,
    reject: false,
    maxOutputBytes: 5 * 1024 * 1024,
  });
  if (patchIdResult.exitCode !== 0 || !patchIdResult.stdout.trim()) return new Map();

  const byHash = new Map<string, string>();
  for (const line of patchIdResult.stdout.split('\n')) {
    const [patchId, hash] = line.trim().split(/\s+/);
    if (patchId && hash) byHash.set(hash, patchId);
  }
  return byHash;
}

function inferCommitPairsForEvent(
  event: GitRebaseReflogEvent,
  patchIdsByHash: Map<string, string>,
  candidatesByPatchId: Map<string, PatchCandidate[]>,
  candidatesBySubject: Map<string, PatchCandidate[]>,
  candidateByHash: Map<string, PatchCandidate>,
): GitRebaseCommitPair[] {
  const rewrittenHashes = new Set(event.commitHashes);
  const replayedSteps = event.steps.filter(
    (step) => step.action === 'pick' || step.action === 'continue',
  );
  const replayed =
    replayedSteps.length > 0
      ? replayedSteps
      : event.commitHashes.map((hash) => ({
          hash,
          shortHash: candidateByHash.get(hash)?.shortHash ?? hash.slice(0, 7),
          message: candidateByHash.get(hash)?.subject ?? '',
        }));
  const pairs: GitRebaseCommitPair[] = [];
  const seen = new Set<string>();

  for (const step of replayed) {
    const patchId = patchIdsByHash.get(step.hash);
    const original =
      (patchId
        ? selectOriginalCandidate(
            candidatesByPatchId.get(patchId) ?? [],
            step.hash,
            step.message,
            rewrittenHashes,
          )
        : null) ??
      selectOriginalCandidate(
        candidatesBySubject.get(normalizeSubject(step.message)) ?? [],
        step.hash,
        step.message,
        rewrittenHashes,
      );
    if (!original) continue;
    const key = `${original.hash}->${step.hash}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({
      originalHash: original.hash,
      originalShortHash: original.shortHash,
      rebasedHash: step.hash,
      rebasedShortHash: step.shortHash,
      subject: step.message || original.subject,
    });
  }

  return pairs;
}

function selectOriginalCandidate(
  candidates: PatchCandidate[],
  rebasedHash: string,
  subject: string,
  rewrittenHashes: Set<string>,
): PatchCandidate | null {
  const pool = candidates.filter(
    (candidate) => candidate.hash !== rebasedHash && !rewrittenHashes.has(candidate.hash),
  );
  if (pool.length === 0) return null;
  return (
    pool.find((candidate) => normalizeSubject(candidate.subject) === normalizeSubject(subject)) ??
    pool[0]
  );
}

function normalizeSubject(subject: string): string {
  return subject.trim().replace(/\s+/g, ' ');
}

function rebaseLabelFor(steps: GitRebaseReflogStep[]): string {
  const subject =
    steps.find((step) => step.subject.toLowerCase().includes('rebase'))?.subject ?? '';
  return subject.split('(')[0]?.trim() || 'rebase';
}

function branchFromFinishMessage(message: string): string | null {
  const ref = message.match(/returning to refs\/heads\/(.+)$/)?.[1];
  return ref ?? null;
}

function ontoFromStartMessage(message: string): string | null {
  return message.match(/^checkout (.+)$/)?.[1] ?? null;
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
 * Get the set of commit hashes that exist on remote-tracking refs but not on
 * any local branch. Useful for marking commits that need to be pulled.
 */
export function getUnpulledHashes(cwd: string): ResultAsync<Set<string>, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const result = await gitRead(['rev-list', '--remotes', '--not', '--branches'], {
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
