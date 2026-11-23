/**
 * funny-native Git checkpoints backing code rewind for every provider.
 *
 * Before each agent turn we snapshot the worktree into private Git refs keyed
 * by thread and user-message id, so rewind never depends on a provider SDK's
 * own checkpoint store.  The snapshot has two trees: the full working tree (which
 * includes untracked, non-ignored files) and the original index, so restore
 * does not turn every local change into a staged change.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gitWrite } from '@funny/core/git';
import { errorMessage } from '@funny/shared/errors';

// Kept under the original Codex-only name so checkpoints captured before
// rewind became provider-agnostic stay restorable.
const CHECKPOINT_REF_PREFIX = 'refs/funny/codex-checkpoints';
const CHECKPOINT_KINDS = ['worktree', 'index'] as const;

export interface GitCheckpointRestoreResult {
  canRewind: boolean;
  filesChanged: string[];
  error?: string;
}

function checkpointRef(
  threadId: string,
  messageId: string,
  kind: (typeof CHECKPOINT_KINDS)[number],
): string {
  // Thread/message IDs originate in our database, but validate them before
  // incorporating them into a Git ref so this helper remains safe at its API
  // boundary as well.
  if (!/^[A-Za-z0-9_-]+$/.test(threadId) || !/^[A-Za-z0-9_-]+$/.test(messageId)) {
    throw new Error('Invalid thread or message ID for Git checkpoint');
  }
  return `${CHECKPOINT_REF_PREFIX}/${threadId}/${messageId}/${kind}`;
}

async function runGit(args: string[], cwd: string, env?: Record<string, string>): Promise<string> {
  const result = await gitWrite(args, { cwd, env, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

/** The two trees of a snapshot: the full working tree and the real index. */
export interface WorktreeSnapshotTrees {
  worktreeTree: string;
  indexTree: string;
}

/**
 * Write the Git-visible state of `cwd` as two trees, without changing the
 * working tree or the real index. Shared by rewind checkpoints and undo
 * snapshots (`git-undo.ts`). Throws when `cwd` is not a git worktree.
 */
export async function snapshotWorktreeTrees(cwd: string): Promise<WorktreeSnapshotTrees> {
  const repoCheck = await gitWrite(['rev-parse', '--is-inside-work-tree'], { cwd, reject: false });
  if (repoCheck.exitCode !== 0 || repoCheck.stdout.trim() !== 'true') {
    throw new Error('Rewind requires a Git worktree');
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'funny-checkpoint-'));
  const alternateIndex = join(tempDir, 'index');
  const alternateEnv = { GIT_INDEX_FILE: alternateIndex };
  try {
    // Build a temporary index from the working tree. This captures staged,
    // unstaged, deleted, and untracked (but intentionally not ignored) files
    // without mutating the user's real index.
    const fromHead = await gitWrite(['read-tree', 'HEAD'], {
      cwd,
      env: alternateEnv,
      reject: false,
    });
    if (fromHead.exitCode !== 0) {
      await runGit(['read-tree', '--empty'], cwd, alternateEnv);
    }
    await runGit(['add', '-A', '--', '.'], cwd, alternateEnv);
    const worktreeTree = await runGit(['write-tree'], cwd, alternateEnv);
    const indexTree = await runGit(['write-tree'], cwd);
    return { worktreeTree, indexTree };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/**
 * Put `trees` back in `cwd` without moving HEAD: the working tree as it was
 * (files created since are removed, ignored files are kept) and the index as
 * it was. Throws on a git failure.
 */
export async function restoreWorktreeTrees(
  cwd: string,
  { worktreeTree, indexTree }: WorktreeSnapshotTrees,
): Promise<void> {
  // Make snapshot files tracked in the real index, then force-check them
  // out. `read-tree -u` intentionally protects an untracked file from an
  // overwrite, but an untracked file may itself be part of our snapshot.
  // `checkout-index -f` is safe here because its source is the snapshot
  // we are explicitly restoring. `clean` can then remove files created
  // after the snapshot without deleting snapshot untracked files.
  // Finally restore the original index tree so staging is exactly as it was
  // when the snapshot was taken.
  await runGit(['read-tree', '--reset', worktreeTree], cwd);
  await runGit(['checkout-index', '--all', '--force'], cwd);
  await runGit(['clean', '-fd', '--', '.'], cwd);
  await runGit(['read-tree', '--reset', indexTree], cwd);
}

/**
 * The commit identity of funny's private snapshot commits (checkpoints, undo
 * snapshots): they are never pushed, so it need not be the user's.
 */
export const SNAPSHOT_IDENTITY = {
  GIT_AUTHOR_NAME: 'funny',
  GIT_AUTHOR_EMAIL: 'funny@localhost',
  GIT_COMMITTER_NAME: 'funny',
  GIT_COMMITTER_EMAIL: 'funny@localhost',
};

/** How long a checkpoint is kept (track-pipeline-runs, design D3). */
const CHECKPOINT_MAX_AGE_MS = 30 * 24 * 60 * 60_000;

/**
 * Capture the exact Git-visible state immediately before an agent turn. The
 * working tree is wrapped in a commit so the checkpoint has a date; restore
 * reads it the same as a bare tree. Checkpoints older than 30 days are pruned
 * afterwards (best effort).
 */
export async function captureGitCheckpoint(params: {
  threadId: string;
  messageId: string;
  cwd: string;
}): Promise<void> {
  const { threadId, messageId, cwd } = params;
  const { worktreeTree, indexTree } = await snapshotWorktreeTrees(cwd);
  const commit = await runGit(
    ['commit-tree', worktreeTree, '-m', `funny checkpoint ${threadId} ${messageId}`],
    cwd,
    SNAPSHOT_IDENTITY,
  );
  await runGit(['update-ref', checkpointRef(threadId, messageId, 'worktree'), commit], cwd);
  await runGit(['update-ref', checkpointRef(threadId, messageId, 'index'), indexTree], cwd);
  await pruneGitCheckpoints(cwd).catch(() => 0);
}

/**
 * Remove checkpoints older than `maxAgeMs`. Only dated ones (a commit at the
 * `worktree` ref) can be aged; those saved before checkpoints had a date are
 * kept until their thread's workspace is cleaned up. Resolves to how many
 * checkpoints it removed.
 */
export function pruneGitCheckpoints(
  cwd: string,
  maxAgeMs = CHECKPOINT_MAX_AGE_MS,
  now: () => number = Date.now,
): Promise<number> {
  return pruneDatedRefs({
    cwd,
    prefix: CHECKPOINT_REF_PREFIX,
    cutoffMs: now() - maxAgeMs,
    // Each checkpoint is dated by its `worktree` commit; its `index` tree goes with it.
    siblingOf: (name) =>
      name.endsWith('/worktree') ? name.replace(/\/worktree$/, '/index') : null,
  });
}

/**
 * Remove the commit refs under `prefix` dated before `cutoffMs`, each with the
 * undated sibling ref `siblingOf` names. A ref `siblingOf` answers null for is
 * not a dated anchor and is skipped (a sibling, or a ref saved before refs had
 * a date). Shared by rewind checkpoints and undo snapshots (`git-undo.ts`).
 * Resolves to how many anchors it removed.
 */
export async function pruneDatedRefs(params: {
  cwd: string;
  prefix: string;
  cutoffMs: number;
  siblingOf: (name: string) => string | null;
}): Promise<number> {
  const { cwd, prefix, siblingOf } = params;
  const listed = await runGit(
    ['for-each-ref', prefix, '--format=%(refname) %(objecttype) %(committerdate:unix)'],
    cwd,
  );
  const cutoff = params.cutoffMs / 1000;
  let removed = 0;
  for (const line of listed.split('\n').filter(Boolean)) {
    const [name, type, date] = line.split(' ');
    const sibling = name ? siblingOf(name) : null;
    if (!name || !sibling || type !== 'commit' || Number(date) >= cutoff) continue;
    await runGit(['update-ref', '-d', name], cwd);
    await gitWrite(['update-ref', '-d', sibling], { cwd, reject: false });
    removed++;
  }
  return removed;
}

/** Remove every checkpoint of a thread (its workspace is being cleaned up). */
export async function removeThreadCheckpoints(cwd: string, threadId: string): Promise<number> {
  if (!/^[A-Za-z0-9_-]+$/.test(threadId)) throw new Error('Invalid thread ID for Git checkpoint');
  const listed = await runGit(
    ['for-each-ref', `${CHECKPOINT_REF_PREFIX}/${threadId}/`, '--format=%(refname)'],
    cwd,
  );
  const refs = listed.split('\n').filter(Boolean);
  for (const ref of refs) await runGit(['update-ref', '-d', ref], cwd);
  return refs.length;
}

/** Restore a checkpoint without moving the branch HEAD. */
export async function restoreGitCheckpoint(params: {
  threadId: string;
  messageId: string;
  cwd: string;
}): Promise<GitCheckpointRestoreResult> {
  const { threadId, messageId, cwd } = params;
  let worktreeTree: string;
  let indexTree: string;
  try {
    worktreeTree = await runGit(
      ['rev-parse', '--verify', checkpointRef(threadId, messageId, 'worktree')],
      cwd,
    );
    indexTree = await runGit(
      ['rev-parse', '--verify', checkpointRef(threadId, messageId, 'index')],
      cwd,
    );
  } catch {
    return {
      canRewind: false,
      filesChanged: [],
      error: 'No Git checkpoint exists for this message. Checkpoints are available from new turns.',
    };
  }

  try {
    await restoreWorktreeTrees(cwd, { worktreeTree, indexTree });

    // `status` also works for repositories without an initial commit, unlike
    // `diff HEAD`. The paths are informational only, but reporting them
    // should never turn a successful restore into a failed rewind.
    const status = await runGit(['status', '--porcelain', '--untracked-files=all'], cwd);
    return {
      canRewind: true,
      filesChanged: status
        .split('\n')
        .filter(Boolean)
        .map((line) => line.slice(3)),
    };
  } catch (err) {
    return {
      canRewind: false,
      filesChanged: [],
      error: `Failed to restore Git checkpoint: ${errorMessage(err)}`,
    };
  }
}

/**
 * Point a forked thread's message at the source thread's checkpoint, so the
 * fork can rewind to turns it inherited. Refs share the same tree objects, so
 * this costs nothing. Returns false when the source message has no checkpoint.
 */
export async function copyGitCheckpoint(params: {
  cwd: string;
  from: { threadId: string; messageId: string };
  to: { threadId: string; messageId: string };
}): Promise<boolean> {
  const { cwd, from, to } = params;
  const trees: string[] = [];
  for (const kind of CHECKPOINT_KINDS) {
    const tree = await gitWrite(
      ['rev-parse', '--verify', '--quiet', checkpointRef(from.threadId, from.messageId, kind)],
      { cwd, reject: false },
    );
    if (tree.exitCode !== 0) return false;
    trees.push(tree.stdout.trim());
  }
  for (const [i, kind] of CHECKPOINT_KINDS.entries()) {
    await runGit(['update-ref', checkpointRef(to.threadId, to.messageId, kind), trees[i]], cwd);
  }
  return true;
}
