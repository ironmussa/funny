import type { Thread } from '@funny/shared';

/**
 * Single source of truth for scratch-vs-normal thread divergence on the
 * client. Mirrors `packages/runtime/src/services/thread-context.ts`.
 *
 * EVERY UI component, store, or hook that needs to behave differently for
 * scratch threads MUST go through one of these predicates — DO NOT inline
 * `if (thread.isScratch)` checks elsewhere. When you discover a new axis of
 * divergence, add the predicate here so the rule stays discoverable.
 *
 * See: CLAUDE.md → "Scratch threads" section.
 */

type ThreadLike = Pick<Thread, 'isScratch'> | null | undefined;
type ThreadGitContextLike = Pick<Thread, 'isScratch' | 'projectId'> | null | undefined;

// ── Identity ─────────────────────────────────────────────────────

/** True for scratch threads (projectless, gitless). */
export function isScratch(thread: ThreadLike): boolean {
  return !!thread?.isScratch;
}

// ── Capability predicates ────────────────────────────────────────

/**
 * Mirrors runtime's `canDoGitOps`. Use to gate every git-related UI
 * affordance: review pane, diff stats, commit/push/PR buttons, branch
 * controls, etc. Scratch threads always return false.
 */
export function canDoGitOps(thread: ThreadLike): boolean {
  if (!thread) return false;
  return !thread.isScratch;
}

/**
 * Whether the sidebar powerline breadcrumb (project → baseBranch → branch)
 * should render for a thread row. Scratch threads have no project/branch
 * even if older DB rows carry stale branch values.
 */
export function canShowPowerline(thread: ThreadLike): boolean {
  return canDoGitOps(thread);
}

/**
 * Whether the "Convert to worktree" / "Create branch" header affordances
 * should appear. Scratch threads cannot have worktrees by design; threads
 * already in worktree mode cannot be re-converted.
 */
export function canConvertToWorktree(
  thread: Pick<Thread, 'isScratch' | 'mode'> | null | undefined,
): boolean {
  if (!thread) return false;
  return !thread.isScratch && thread.mode !== 'worktree';
}

/**
 * Whether to issue git-status API calls for this thread. Scratch threads
 * have no working tree — the runtime rejects with 400, so we skip the
 * request entirely at the client chokepoint.
 */
export function canFetchGitStatus(thread: ThreadLike): boolean {
  return canDoGitOps(thread);
}

/**
 * Whether git history/graph calls are valid for this thread. Unlike status,
 * history endpoints resolve the owning project before reading git data, so a
 * projectless scratch/draft thread must be treated as "no git context".
 */
export function canLoadGitHistory(thread: ThreadGitContextLike): boolean {
  if (!thread?.projectId) return false;
  return canDoGitOps(thread);
}

// ── Sharing ──────────────────────────────────────────────────────

/**
 * Whether the current user is viewing a thread that was SHARED with them
 * (i.e. they are not its owner). Read-only: a sharee may read + comment but
 * must never drive the agent, do git, fork/rewind, or change model/permission.
 * Gate every such affordance on this predicate instead of inlining an owner
 * check. `currentUserId` comes from the auth store at the call site.
 *
 * Mirrors the server's split: `requireThreadView` (owner OR sharee) for reads,
 * `requireThreadOwner` for everything else.
 */
export function isReadOnlyShare(
  thread: Pick<Thread, 'userId'> | null | undefined,
  currentUserId: string | null | undefined,
): boolean {
  if (!thread || !currentUserId) return false;
  return thread.userId !== currentUserId;
}

/**
 * Whether the current viewer may STEER this thread (send follow-ups). True for
 * the owner, OR a sharee whose grant level is `steer` (thread-sharing-steer).
 * `viewerShareLevel` is populated by the single-thread fetch (`GET /threads/:id`);
 * a `view` sharee — or a sharee on a list-only thread with no level loaded —
 * returns false. Mirrors the server's `requireThreadSteer` gate.
 */
export function canSteerShare(
  thread: Pick<Thread, 'userId' | 'viewerShareLevel'> | null | undefined,
  currentUserId: string | null | undefined,
): boolean {
  if (!thread || !currentUserId) return false;
  if (thread.userId === currentUserId) return true; // owner
  return thread.viewerShareLevel === 'steer';
}

/**
 * Whether the current viewer may POST a comment on this thread. Owner → yes; a
 * `comment` or `steer` sharee → yes; a `view` (read-only) sharee → no. Mirrors
 * the server's `comment` capability gate on `POST /:id/comments`. Use this to
 * gate the comment INPUT; reading comments is governed by `canShowComments`.
 */
export function canCommentShare(
  thread: Pick<Thread, 'userId' | 'viewerShareLevel'> | null | undefined,
  currentUserId: string | null | undefined,
): boolean {
  if (!thread || !currentUserId) return false;
  if (thread.userId === currentUserId) return true; // owner
  return thread.viewerShareLevel === 'comment' || thread.viewerShareLevel === 'steer';
}

/**
 * Whether the current viewer may READ git state (status/diff/log) for this
 * thread. Owner → yes; a `steer` sharee → yes (read-only); a `view` sharee → no.
 * Git WRITE (commit/push/PR) stays owner-only — gate those on ownership, never
 * on this predicate. Mirrors the server git-route split (reads → steer, writes →
 * owner). Kept separate from `canSteerShare` so the two can diverge later
 * without touching call sites, though today `steer` unlocks both.
 */
export function canViewGitShare(
  thread: Pick<Thread, 'userId' | 'viewerShareLevel'> | null | undefined,
  currentUserId: string | null | undefined,
): boolean {
  return canSteerShare(thread, currentUserId);
}

/**
 * Whether the Comments affordance (header icon + docked panel) should appear.
 * Comments are a thread-level discussion shared by the owner and every sharee,
 * so this is true for ANY real thread the user can view — owner OR sharee, with
 * or without git. The only exclusion is scratch threads, which are private,
 * projectless, and have no audience to comment with.
 */
export function canShowComments(thread: ThreadLike): boolean {
  if (!thread) return false;
  return !thread.isScratch;
}

// ── Routing ──────────────────────────────────────────────────────

/**
 * App-internal route for a thread's detail view. Scratch threads live at
 * `/scratch/:id`; normal threads at `/projects/:projectId/threads/:id`.
 * Use this everywhere instead of hand-rolled string interpolation.
 */
export function getThreadRoute(thread: Pick<Thread, 'id' | 'projectId' | 'isScratch'>): string {
  if (thread.isScratch) return `/scratch/${thread.id}`;
  return `/projects/${thread.projectId}/threads/${thread.id}`;
}

// ── Sidebar storage discriminator ────────────────────────────────

/**
 * Which Zustand bucket a thread is stored in. WS handlers use this to
 * decide whether to patch `threadsByProject[pid]` or `scratchThreads`.
 */
export type SidebarBucket = 'scratch' | 'project';

export function getSidebarBucket(thread: ThreadLike): SidebarBucket {
  return thread?.isScratch ? 'scratch' : 'project';
}
