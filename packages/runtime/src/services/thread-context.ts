/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: domain-service
 * @domain layer: domain
 *
 * Centralizes the scratch-vs-normal-thread divergence. Every caller that
 * needs the working directory for a thread, or needs to decide whether git
 * operations are allowed, MUST go through this module — DO NOT inline
 * `if (thread.isScratch)` checks elsewhere.
 *
 * See: openspec/changes/scratch-threads/design.md (D3, D7).
 */

import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Thread } from '@funny/shared';
import { err, ok, type Result } from 'neverthrow';

export type ThreadContextError =
  | { kind: 'project-required'; message: string }
  | { kind: 'worktree-missing'; message: string };

export interface ResolveCwdProject {
  path: string;
}

/**
 * Resolve the working directory the agent should run in for the given thread.
 *
 * - Scratch threads (`isScratch = true`) → `<userHome>/.funny/scratch/<userId>/<threadId>/`.
 * - Worktree threads (`mode === 'worktree'`) → `thread.worktreePath`.
 * - Otherwise → `project.path`.
 */
export function resolveThreadCwd(
  thread: Pick<Thread, 'id' | 'isScratch' | 'userId' | 'mode' | 'worktreePath'>,
  project: ResolveCwdProject | null,
): Result<string, ThreadContextError> {
  if (thread.isScratch) {
    return ok(scratchPathFor(thread.userId, thread.id));
  }
  if (!project) {
    return err({
      kind: 'project-required',
      message: `Thread ${thread.id} is not scratch but has no project`,
    });
  }
  if (thread.mode === 'worktree') {
    if (!thread.worktreePath) {
      return err({
        kind: 'worktree-missing',
        message: `Worktree thread ${thread.id} has no worktreePath`,
      });
    }
    return ok(thread.worktreePath);
  }
  return ok(project.path);
}

/**
 * Returns true when git/repo operations (diff, stage, commit, push, PR) are
 * available for the given thread. False for scratch threads — they have no
 * repo by design.
 *
 * Callers MUST use this helper rather than reading `thread.isScratch`
 * directly, so the rule stays in one place.
 */
export function canDoGitOps(thread: Pick<Thread, 'isScratch'>): boolean {
  return !thread.isScratch;
}

/**
 * Derive (without persisting) the on-disk scratch directory for a thread.
 * The directory is created lazily on first agent spawn and removed on
 * thread delete — see `agent-lifecycle.ts` and `thread-service/update.ts`.
 *
 * Security L-1: enforce the path-traversal invariant at the boundary.
 * `userId` comes from Better Auth (nanoid-style) and `threadId` is
 * server-generated via `nanoid()`, so in practice neither contains `..`
 * or `/`. But this function is the single source of truth for the scratch
 * cwd, which becomes the trusted scope for browse / file / search routes
 * and the agent's working directory. An explicit regex makes the
 * invariant local and obvious — call sites no longer need to remember
 * that they're feeding it sanitised values.
 */
const SCRATCH_ID_RE = /^[A-Za-z0-9_-]+$/;

export function scratchPathFor(userId: string, threadId: string): string {
  if (!SCRATCH_ID_RE.test(userId)) {
    throw new Error(`scratchPathFor: userId failed shape check (got: ${JSON.stringify(userId)})`);
  }
  if (!SCRATCH_ID_RE.test(threadId)) {
    throw new Error(
      `scratchPathFor: threadId failed shape check (got: ${JSON.stringify(threadId)})`,
    );
  }
  return join(homedir(), '.funny', 'scratch', userId, threadId);
}

/**
 * Per-user directory NAME (not full path) for the temp assets root. Lives
 * under the OS tmpdir as `funny-<userId>`. The `userId` is the cross-user
 * isolation boundary — same invariant as scratch — so it must pass the shape
 * check before it becomes part of a trusted filesystem scope.
 */
export function tmpAssetsDirName(userId: string): string {
  if (!SCRATCH_ID_RE.test(userId)) {
    throw new Error(`tmpAssetsDirName: userId failed shape check (got: ${JSON.stringify(userId)})`);
  }
  return `funny-${userId}`;
}

/**
 * On-disk root for browser-previewable dev assets the agent generates OUTSIDE
 * any project tree (screenshots, renders, short clips) — `<os-tmpdir>/funny-<userId>/`.
 *
 * This is exposed to the agent as `FUNNY_ASSETS_DIR` and authorized for media
 * serving by `resolveProjectScope` in `routes/files.ts`. The directory is
 * created lazily (0700) on agent spawn; the OS tmpdir parent is world-writable,
 * so the mode matters and reads are still gated by the realpath/scope re-check
 * on every request.
 */
export function tmpAssetsPathFor(userId: string): string {
  return join(tmpdir(), tmpAssetsDirName(userId));
}
