/**
 * @domain subdomain: Git Operations
 * @domain subdomain-type: supporting
 * @domain type: app-service
 * @domain layer: application
 * @domain depends: ActivityTracker
 *
 * Records a change funny makes to the user's checkout (track-funny-actions,
 * design D5): switching its branch when a local thread starts on another base
 * branch, the branch checkout route's stash, and a merge that leaves the main
 * checkout on the target branch. One instant `checkout.switch` activity each.
 */
import type { ActivityEffect, ActivityOrigin } from '@funny/shared';

import { recordActivity as defaultRecordActivity } from './activity-tracker.js';

export interface CheckoutSwitch {
  userId: string;
  projectId: string;
  threadId?: string | null;
  fromBranch?: string | null;
  toBranch: string;
  /** Changes were stashed before the switch. */
  stashed: boolean;
  reason: 'thread-created' | 'branch-checkout' | 'merged';
  origin: ActivityOrigin;
  /** Set when the switch (or restoring the stash) failed. */
  error?: string;
  /** False when the branch did not change (a failed checkout). */
  switched?: boolean;
}

export function recordCheckoutSwitch(
  change: CheckoutSwitch,
  record: typeof defaultRecordActivity = defaultRecordActivity,
): Promise<void> {
  if (change.fromBranch && change.fromBranch === change.toBranch && !change.error) {
    return Promise.resolve();
  }
  const effects: ActivityEffect[] = [];
  if (change.stashed) {
    effects.push({ effect: 'changes-stashed', target: change.fromBranch ?? change.toBranch });
  }
  if (change.switched !== false) {
    effects.push({ effect: 'branch-checked-out', target: change.toBranch });
  }
  const from = change.fromBranch ? ` from ${change.fromBranch}` : '';
  return record(
    {
      kind: 'checkout.switch',
      userId: change.userId,
      projectId: change.projectId,
      threadId: change.threadId ?? null,
      title: `Switched the checkout to ${change.toBranch}${from}`,
      input: {
        fromBranch: change.fromBranch || undefined,
        toBranch: change.toBranch,
        stashed: change.stashed,
        reason: change.reason,
      },
      origin: change.origin,
    },
    change.error ? { ok: false, error: change.error, effects } : { ok: true, effects },
  );
}
