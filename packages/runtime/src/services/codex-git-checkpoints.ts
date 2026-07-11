/**
 * Local Git checkpoints used by Codex threads.
 *
 * The Codex SDK has no rewind/checkpoint API.  Before each Codex turn we
 * therefore snapshot the worktree into private Git refs keyed by thread and
 * user-message id.  The snapshot has two trees: the full working tree (which
 * includes untracked, non-ignored files) and the original index, so restore
 * does not turn every local change into a staged change.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { gitWrite } from '@funny/core/git';

const CHECKPOINT_REF_PREFIX = 'refs/funny/codex-checkpoints';

export interface CodexCheckpointRestoreResult {
  canRewind: boolean;
  filesChanged: string[];
  error?: string;
}

function checkpointRef(threadId: string, messageId: string, kind: 'worktree' | 'index'): string {
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

/** Capture the exact Git-visible state immediately before a Codex turn. */
export async function captureCodexCheckpoint(params: {
  threadId: string;
  messageId: string;
  cwd: string;
}): Promise<void> {
  const { threadId, messageId, cwd } = params;
  const repoCheck = await gitWrite(['rev-parse', '--is-inside-work-tree'], { cwd, reject: false });
  if (repoCheck.exitCode !== 0 || repoCheck.stdout.trim() !== 'true') {
    throw new Error('Codex rewind requires a Git worktree');
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'funny-codex-checkpoint-'));
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

    await runGit(['update-ref', checkpointRef(threadId, messageId, 'worktree'), worktreeTree], cwd);
    await runGit(['update-ref', checkpointRef(threadId, messageId, 'index'), indexTree], cwd);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

/** Restore a Codex checkpoint without moving the branch HEAD. */
export async function restoreCodexCheckpoint(params: {
  threadId: string;
  messageId: string;
  cwd: string;
}): Promise<CodexCheckpointRestoreResult> {
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
      error:
        'No Git checkpoint exists for this message. Codex checkpoints are available from new turns.',
    };
  }

  try {
    // Make snapshot files tracked in the real index, then force-check them
    // out. `read-tree -u` intentionally protects an untracked file from an
    // overwrite, but an untracked file may itself be part of our snapshot.
    // `checkout-index -f` is safe here because its source is the checkpoint
    // we are explicitly restoring. `clean` can then remove files created
    // after the checkpoint without deleting snapshot untracked files.
    // Finally restore the original index tree so staging is exactly as it was
    // when the checkpoint was captured.
    await runGit(['read-tree', '--reset', worktreeTree], cwd);
    await runGit(['checkout-index', '--all', '--force'], cwd);
    await runGit(['clean', '-fd', '--', '.'], cwd);
    await runGit(['read-tree', '--reset', indexTree], cwd);

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
      error: `Failed to restore Git checkpoint: ${(err as Error).message}`,
    };
  }
}
