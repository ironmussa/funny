/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: GitUndo
 *
 * The git commands a user runs that throw work away (track-user-and-scheduled-
 * actions, design D5), each as one `git.destructive` activity with an undo
 * snapshot saved first (`git-undo.ts`). Routes call these instead of the git
 * function, so every discard, reset hard and stash drop can be put back.
 */
import { gitRead } from '@funny/core/git';
import type { DomainError } from '@funny/shared/errors';
import { ResultAsync } from 'neverthrow';

import { recordActivity } from './activity-tracker.js';
import {
  restoreUndoSnapshot,
  runDestructive,
  type GitUndoDeps,
  type RestoreOutcome,
} from './git-undo.js';
import * as tm from './thread-manager.js';

/** Where the command runs: a project checkout, or a thread's worktree. */
export interface DestructiveTarget {
  userId: string;
  cwd: string;
  projectId?: string | null;
  threadId?: string | null;
}

/** The project of a thread route's activity (the runner reads it from the thread). */
export async function threadTarget(
  userId: string,
  threadId: string,
  cwd: string,
): Promise<DestructiveTarget> {
  const thread = await tm.getThread(threadId);
  return { userId, cwd, threadId, projectId: thread?.projectId || null };
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? `1 ${one}` : `${n} ${many}`;
}

/** Discard the changes to `paths` (tracked files restored, untracked ones deleted). */
export function discardTracked<T>(
  target: DestructiveTarget,
  paths: string[],
  run: () => ResultAsync<T, DomainError>,
): ResultAsync<T, DomainError> {
  return runDestructive({
    spec: {
      userId: target.userId,
      projectId: target.projectId ?? null,
      threadId: target.threadId ?? null,
      title: `Discard changes to ${plural(paths.length, 'file', 'files')}`,
      input: { action: 'discard', paths },
    },
    cwd: target.cwd,
    snapshot: { kind: 'worktree' },
    run,
    effectsOf: () => paths.map((path) => ({ effect: 'changes-discarded' as const, target: path })),
  });
}

/** `git reset --hard <hash>`; the activity names the commit it moved from. */
export function resetHardTracked<T>(
  target: DestructiveTarget,
  hash: string,
  run: () => ResultAsync<T, DomainError>,
): ResultAsync<T, DomainError> {
  return ResultAsync.fromSafePromise(currentHead(target.cwd)).andThen((fromHead) =>
    resetHardFrom(target, hash, fromHead, run),
  );
}

async function currentHead(cwd: string): Promise<string | null> {
  const head = await gitRead(['rev-parse', '--verify', '-q', 'HEAD'], { cwd, reject: false });
  return head.exitCode === 0 ? head.stdout.trim() || null : null;
}

function resetHardFrom<T>(
  target: DestructiveTarget,
  hash: string,
  fromHead: string | null,
  run: () => ResultAsync<T, DomainError>,
): ResultAsync<T, DomainError> {
  const short = (sha: string) => sha.slice(0, 12);
  return runDestructive({
    spec: {
      userId: target.userId,
      projectId: target.projectId ?? null,
      threadId: target.threadId ?? null,
      title: `Reset hard to ${short(hash)}`,
      input: { action: 'reset-hard', toHead: hash, fromHead: fromHead ?? undefined },
    },
    cwd: target.cwd,
    snapshot: { kind: 'worktree' },
    run,
    effectsOf: () => [
      {
        effect: 'commits-reset',
        target: fromHead ? `${short(fromHead)} → ${short(hash)}` : short(hash),
      },
    ],
  });
}

/** `git stash drop stash@{n}`. */
export function stashDropTracked<T>(
  target: DestructiveTarget,
  stashIndex: number,
  run: () => ResultAsync<T, DomainError>,
): ResultAsync<T, DomainError> {
  const stashRef = `stash@{${stashIndex}}`;
  return runDestructive({
    spec: {
      userId: target.userId,
      projectId: target.projectId ?? null,
      threadId: target.threadId ?? null,
      title: `Drop ${stashRef}`,
      input: { action: 'stash-drop', stashIndex },
    },
    cwd: target.cwd,
    snapshot: { kind: 'stash', stashRef },
    run,
    effectsOf: () => [{ effect: 'stash-dropped', target: stashRef }],
  });
}

/** Rewind a thread's code to the checkpoint before `messageId`. */
export function rewindTracked<T>(
  target: DestructiveTarget,
  messageId: string,
  run: () => ResultAsync<T, DomainError>,
): ResultAsync<T, DomainError> {
  return runDestructive({
    spec: {
      userId: target.userId,
      projectId: target.projectId ?? null,
      threadId: target.threadId ?? null,
      title: 'Rewind the code to an earlier message',
      input: { action: 'rewind', messageId },
    },
    cwd: target.cwd,
    snapshot: { kind: 'worktree' },
    run,
    effectsOf: () => [{ effect: 'code-rewound', target: messageId }],
  });
}

/**
 * Put an activity's undo snapshot back (design D6). The state it replaces is
 * saved as a new snapshot, named by the restore's own activity, so the
 * restore can be undone too. `404 snapshot-gone` when it was pruned.
 */
export function restoreTracked(
  target: DestructiveTarget,
  activityId: string,
  deps: Pick<GitUndoDeps, 'recordActivity' | 'newId'> = {
    recordActivity,
    newId: () => crypto.randomUUID(),
  },
): ResultAsync<RestoreOutcome, DomainError> {
  const id = deps.newId();
  const spec = {
    id,
    kind: 'git.destructive' as const,
    userId: target.userId,
    projectId: target.projectId ?? null,
    threadId: target.threadId ?? null,
    title: 'Restore an undo snapshot',
    input: { action: 'restore' },
    origin: 'user' as const,
  };
  return restoreUndoSnapshot({ cwd: target.cwd, activityId, restoreActivityId: id })
    .map((outcome) => {
      void deps.recordActivity(spec, {
        ok: true,
        effects: [{ effect: 'snapshot-saved', target: outcome.ref }],
        resultRef: { snapshot: outcome.ref },
      });
      return outcome;
    })
    .mapErr((error) => {
      // A pruned snapshot is answered, not recorded: nothing was attempted.
      if (error.message !== 'snapshot-gone') {
        void deps.recordActivity(spec, { ok: false, error: error.message });
      }
      return error;
    });
}
