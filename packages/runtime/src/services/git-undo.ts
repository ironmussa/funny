import { gitWrite } from '@funny/core/git';
/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: ActivityTracker, GitCheckpoints
 *
 * Undo snapshots (track-user-and-scheduled-actions, design D4–D5): before a
 * git command that throws work away (discard, reset --hard, stash drop,
 * rewind) the runner saves what it is about to remove in a private ref of the
 * repository, named by the activity that records the command, so the user
 * can put it back from the activity panel.
 *
 *   refs/funny/undo/<activityId>        a commit of the full working tree
 *                                       (untracked, non-ignored files too),
 *                                       parent = HEAD, message names HEAD;
 *                                       or the stash commit that was dropped
 *   refs/funny/undo/<activityId>-index  the index tree (worktree snapshots)
 *
 * Snapshots older than 30 days are pruned whenever a new one is saved.
 * `refs/funny/*` is not pushed with a branch (only `git push --mirror` would).
 */
import type { ActivityEffect } from '@funny/shared';
import { badRequest, internal, notFound, type DomainError } from '@funny/shared/errors';
import { err, errAsync, ok, ResultAsync, type Result } from 'neverthrow';

import { log } from '../lib/logger.js';
import { recordActivity as defaultRecordActivity, type ActivitySpec } from './activity-tracker.js';
import { restoreWorktreeTrees, snapshotWorktreeTrees } from './git-checkpoints.js';

const UNDO_REF_PREFIX = 'refs/funny/undo';
const UNDO_SNAPSHOT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

const ACTIVITY_ID = /^[A-Za-z0-9_-]{1,128}$/;
const HEAD_LINE = /^head ([0-9a-f]{40,64})$/m;

/** The commit identity of a snapshot: snapshots are never pushed, so it need not be the user's. */
const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'funny',
  GIT_AUTHOR_EMAIL: 'funny@localhost',
  GIT_COMMITTER_NAME: 'funny',
  GIT_COMMITTER_EMAIL: 'funny@localhost',
};

export type UndoSnapshotKind = 'worktree' | 'stash';

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The ref of an activity's snapshot; refuses an id that could not be one. */
function undoRef(activityId: string): Result<string, DomainError> {
  return ACTIVITY_ID.test(activityId)
    ? ok(`${UNDO_REF_PREFIX}/${activityId}`)
    : err(badRequest('Invalid activity id for an undo snapshot'));
}

async function git(cwd: string, args: string[], env?: Record<string, string>): Promise<string> {
  const result = await gitWrite(args, { cwd, env, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git ${args[0]} failed`);
  }
  return result.stdout.trim();
}

async function tryGit(cwd: string, args: string[]): Promise<string | null> {
  const result = await gitWrite(args, { cwd, reject: false });
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

/**
 * Saves what a destructive command is about to remove. `stash` saves the
 * stash entry `stashRef` (e.g. `stash@{2}`); `worktree` saves the working
 * tree, the index and HEAD.
 */
export function saveUndoSnapshot(params: {
  cwd: string;
  activityId: string;
  kind: UndoSnapshotKind;
  stashRef?: string;
}): ResultAsync<{ ref: string }, DomainError> {
  const ref = undoRef(params.activityId);
  if (ref.isErr()) return errAsync(ref.error);
  const { cwd, kind } = params;
  return ResultAsync.fromPromise(
    (async () => {
      if (kind === 'stash') {
        if (!params.stashRef || !/^stash@\{\d+\}$/.test(params.stashRef)) {
          throw badRequest('Invalid stash entry');
        }
        const sha = await git(cwd, ['rev-parse', '--verify', params.stashRef]);
        await git(cwd, ['update-ref', ref.value, sha]);
      } else {
        const trees = await snapshotWorktreeTrees(cwd);
        const head = await tryGit(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
        const message = `funny undo snapshot\n\n${head ? `head ${head}\n` : ''}`;
        const commit = await git(
          cwd,
          ['commit-tree', trees.worktreeTree, ...(head ? ['-p', head] : []), '-m', message],
          SNAPSHOT_IDENTITY,
        );
        await git(cwd, ['update-ref', ref.value, commit]);
        await git(cwd, ['update-ref', `${ref.value}-index`, trees.indexTree]);
      }
      // Best effort: an old snapshot left behind is harmless.
      await pruneUndoSnapshots(cwd).match(
        () => undefined,
        (error) =>
          log.warn('Failed to prune undo snapshots', {
            namespace: 'git-undo',
            error: error.message,
          }),
      );
      return { ref: ref.value };
    })(),
    (error) =>
      (error as DomainError)?.type
        ? (error as DomainError)
        : internal(`Could not save an undo snapshot: ${messageOf(error)}`),
  );
}

export interface RestoreOutcome {
  /** The snapshot of the state the restore replaced. */
  ref: string;
  kind: UndoSnapshotKind;
}

/**
 * Puts an activity's snapshot back. The current state is saved first, under
 * `restoreActivityId`, so the restore can itself be undone. A worktree
 * snapshot restores the working tree and index, and moves the checked-out
 * branch back with `reset --soft` only when a reset moved it; a stash
 * snapshot goes back into the stash list.
 */
export function restoreUndoSnapshot(params: {
  cwd: string;
  activityId: string;
  restoreActivityId: string;
}): ResultAsync<RestoreOutcome, DomainError> {
  const ref = undoRef(params.activityId);
  if (ref.isErr()) return errAsync(ref.error);
  const { cwd } = params;
  return ResultAsync.fromPromise(
    (async () => {
      const target = await tryGit(cwd, ['rev-parse', '--verify', '-q', ref.value]);
      if (!target) throw notFound('snapshot-gone');
      const indexTree = await tryGit(cwd, ['rev-parse', '--verify', '-q', `${ref.value}-index`]);
      const kind: UndoSnapshotKind = indexTree ? 'worktree' : 'stash';

      const saved = await saveUndoSnapshot({
        cwd,
        activityId: params.restoreActivityId,
        kind: 'worktree',
      });
      if (saved.isErr()) throw saved.error;

      if (kind === 'stash') {
        await git(cwd, ['stash', 'store', '-m', 'funny: restored stash', target]);
      } else {
        const worktreeTree = await git(cwd, ['rev-parse', `${target}^{tree}`]);
        const message = await git(cwd, ['log', '-1', '--format=%B', target]);
        const head = HEAD_LINE.exec(message)?.[1] ?? null;
        const currentHead = await tryGit(cwd, ['rev-parse', '--verify', '-q', 'HEAD']);
        if (head && head !== currentHead) await git(cwd, ['reset', '--soft', head]);
        await restoreWorktreeTrees(cwd, { worktreeTree, indexTree: indexTree! });
      }
      return { ref: saved.value.ref, kind };
    })(),
    (error) =>
      (error as DomainError)?.type
        ? (error as DomainError)
        : internal(`Could not restore the snapshot: ${messageOf(error)}`),
  );
}

/** Removes snapshots older than `maxAgeMs`; resolves to how many it removed. */
export function pruneUndoSnapshots(
  cwd: string,
  maxAgeMs = UNDO_SNAPSHOT_MAX_AGE_MS,
  now: () => number = Date.now,
): ResultAsync<number, DomainError> {
  return ResultAsync.fromPromise(
    (async () => {
      const listed = await git(cwd, [
        'for-each-ref',
        UNDO_REF_PREFIX,
        '--format=%(refname) %(objecttype) %(committerdate:unix)',
      ]);
      const cutoff = (now() - maxAgeMs) / 1000;
      let removed = 0;
      for (const line of listed.split('\n').filter(Boolean)) {
        const [name, type, date] = line.split(' ');
        // An `-index` ref is a tree with no date: it goes with its snapshot.
        if (!name || type !== 'commit' || name.endsWith('-index')) continue;
        if (Number(date) >= cutoff) continue;
        await git(cwd, ['update-ref', '-d', name]);
        await tryGit(cwd, ['update-ref', '-d', `${name}-index`]);
        removed++;
      }
      return removed;
    })(),
    (error) => internal(`Could not prune undo snapshots: ${messageOf(error)}`),
  );
}

// ── Destructive commands ───────────────────────────────────────────────

export interface DestructiveRun<T> {
  /** The `git.destructive` activity of the command. */
  spec: Omit<ActivitySpec, 'id' | 'kind' | 'origin'>;
  cwd: string;
  snapshot: { kind: UndoSnapshotKind; stashRef?: string };
  run: () => PromiseLike<Result<T, DomainError>>;
  /** What the command changed, recorded with the snapshot. */
  effectsOf: (value: T) => ActivityEffect[];
}

export interface GitUndoDeps {
  recordActivity: typeof defaultRecordActivity;
  newId: () => string;
}

const defaultDeps: GitUndoDeps = {
  recordActivity: defaultRecordActivity,
  newId: () => crypto.randomUUID(),
};

/**
 * Saves an undo snapshot, then runs the command, then records one
 * `git.destructive` activity naming the snapshot. When the snapshot cannot be
 * saved the command does not run. A failed command keeps its snapshot (it may
 * have partly run).
 */
export function runDestructive<T>(
  command: DestructiveRun<T>,
  deps: GitUndoDeps = defaultDeps,
): ResultAsync<T, DomainError> {
  return new ResultAsync(runDestructiveSteps(command, deps));
}

async function runDestructiveSteps<T>(
  command: DestructiveRun<T>,
  deps: GitUndoDeps,
): Promise<Result<T, DomainError>> {
  const id = deps.newId();
  const spec: ActivitySpec = {
    ...command.spec,
    id,
    kind: 'git.destructive',
    origin: 'user',
  };

  const saved = await saveUndoSnapshot({
    cwd: command.cwd,
    activityId: id,
    kind: command.snapshot.kind,
    stashRef: command.snapshot.stashRef,
  });
  if (saved.isErr()) {
    void deps.recordActivity(spec, {
      ok: false,
      error: `${saved.error.message}. Nothing was changed.`,
    });
    return err(saved.error);
  }

  const snapshotEffect: ActivityEffect = { effect: 'snapshot-saved', target: saved.value.ref };
  const result = await command.run();
  if (result.isErr()) {
    void deps.recordActivity(spec, {
      ok: false,
      error: result.error.message,
      effects: [snapshotEffect],
    });
    return result;
  }
  void deps.recordActivity(spec, {
    ok: true,
    // Leave room for the snapshot within the 20-effect cap.
    effects: [...command.effectsOf(result.value).slice(0, 19), snapshotEffect],
    resultRef: { snapshot: saved.value.ref },
  });
  return ok(result.value);
}
