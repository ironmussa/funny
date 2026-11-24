import type { Activity } from '@funny/shared';
import { ACTIVITY_KINDS, isActivityKind } from '@funny/shared/activities';

import { getThreadRoute } from '@/lib/thread-variant';
import { buildPath } from '@/lib/url';

/**
 * Where retrying an activity takes the user (track-background-activities).
 * Retry never starts the operation: a clone opens its form filled from the
 * recorded input; a worktree setup or git workflow opens the thread it ran in
 * (with the review pane for the latter), or its project when the thread is
 * gone. A failed workspace cleanup opens the project's worktree list, where
 * the leftover worktree can be removed (track-funny-actions). Kinds the server
 * runs on its own with nothing for the user to redo (sandbox stop / wake /
 * destroy, factory actions, agents stopped) have no entry, so no retry. Add an
 * entry here when you add a kind the user can redo.
 */

export interface RetryDeps {
  navigate: (path: string) => void;
  findThread: (threadId: string) => { id: string; projectId: string; isScratch?: boolean } | null;
  openCloneForm: (values: { cloneUrl: string; destinationPath: string; name?: string }) => void;
  openReviewPane: () => void;
  /** Opens the review pane on its Worktrees tab, which lists and removes worktrees. */
  openWorktrees: () => void;
  /** Opens the review pane on its pull requests tab. */
  openPullRequests: () => void;
}

type RetryTarget = (activity: Activity, deps: RetryDeps) => boolean;

function openThreadOrProject(activity: Activity, deps: RetryDeps): 'thread' | 'project' | null {
  const thread = activity.threadId ? deps.findThread(activity.threadId) : null;
  if (thread) {
    deps.navigate(buildPath(getThreadRoute(thread)));
    return 'thread';
  }
  if (activity.projectId) {
    deps.navigate(buildPath(`/projects/${activity.projectId}`));
    return 'project';
  }
  return null;
}

function openProjectWorktrees(activity: Activity, deps: RetryDeps): boolean {
  if (!activity.projectId) return false;
  deps.navigate(buildPath(`/projects/${activity.projectId}`));
  deps.openWorktrees();
  return true;
}

const RETRY_TARGETS: Record<string, RetryTarget> = {
  'project.clone': (activity, deps) => {
    const parsed = ACTIVITY_KINDS['project.clone'].input.safeParse(activity.input);
    if (!parsed.success) return false;
    deps.openCloneForm(parsed.data);
    return true;
  },
  'worktree.setup': (activity, deps) => openThreadOrProject(activity, deps) !== null,
  'git.workflow': (activity, deps) => {
    const opened = openThreadOrProject(activity, deps);
    if (opened === 'thread') deps.openReviewPane();
    return opened !== null;
  },
  'workspace.cleanup': openProjectWorktrees,
  'workspace.prune': openProjectWorktrees,
  'checkout.switch': (activity, deps) => openThreadOrProject(activity, deps) !== null,
  // track-user-and-scheduled-actions: where each new kind is redone.
  'automation.unscheduled': (activity, deps) => {
    if (!activity.projectId) return false;
    deps.navigate(buildPath(`/projects/${activity.projectId}/settings/automations`));
    return true;
  },
  'github.write': (activity, deps) => {
    if (!activity.projectId) return false;
    deps.navigate(buildPath(`/projects/${activity.projectId}`));
    // A pull request write is redone from its pull request; a publish or an issue delete from the project.
    if (activity.input.action === 'pr-merge' || activity.input.action === 'pr-revert-file') {
      deps.openPullRequests();
    }
    return true;
  },
  'sandbox.provision': (activity, deps) => openThreadOrProject(activity, deps) !== null,
};

/** Whether the panel offers a retry for this activity. */
export function canRetryActivity(activity: Activity): boolean {
  return (
    (activity.status === 'failed' || activity.status === 'interrupted') &&
    isActivityKind(activity.kind) &&
    Object.hasOwn(RETRY_TARGETS, activity.kind)
  );
}

/** Opens the retry target; false when there is none to open. */
export function retryActivity(activity: Activity, deps: RetryDeps): boolean {
  if (!canRetryActivity(activity)) return false;
  return RETRY_TARGETS[activity.kind](activity, deps);
}

/** How long a runner keeps undo snapshots (`git-undo.ts`, 30 days). */
const SNAPSHOT_RETENTION_MS = 30 * 24 * 60 * 60_000;

/**
 * Whether the panel offers Restore: a finished activity that saved an undo
 * snapshot young enough to still be on the runner. The runner has the last
 * word (`404 snapshot-gone`).
 */
export function canRestoreActivity(activity: Activity, now = Date.now()): boolean {
  if (activity.status !== 'succeeded' || !activity.resultRef?.snapshot) return false;
  const ended = Date.parse(activity.endedAt ?? activity.startedAt);
  return Number.isFinite(ended) && now - ended < SNAPSHOT_RETENTION_MS;
}
