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
