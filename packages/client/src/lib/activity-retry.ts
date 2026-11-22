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
