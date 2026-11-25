import type { Activity } from '@funny/shared';
import { toast } from 'sonner';

import i18n from '@/i18n/config';

import { useActivityPanelStore } from './activity-panel-store';

/**
 * Factory run controls a member asks for (stop, retry, split, approve merge):
 * the screen that asked shows the server's refusal itself (the board's bulk
 * actions, the run controls), so a toast here would say it twice.
 */
const CONTROL_KINDS: ReadonlySet<string> = new Set([
  'factory.stop',
  'factory.retry',
  'factory.split',
  'factory.approve-merge',
]);

/**
 * Whether the request that failed already told the member: a factory run
 * control they asked for. One an agent asked for (it carries the agent's
 * thread) reaches the member only through this toast.
 */
const shownByRequester = (activity: Activity): boolean =>
  CONTROL_KINDS.has(activity.kind) && activity.threadId === null;

/**
 * The toast for an activity that just failed (track-background-activities):
 * names it and offers to open the activity panel. Raised from the realtime
 * update only, never from a list load, and not for a failure the request that
 * caused it already showed.
 */
export function notifyActivityFailed(activity: Activity): void {
  if (shownByRequester(activity)) return;
  toast.error(i18n.t('activity.failedToast', { title: activity.title }), {
    id: `activity-failed-${activity.id}`,
    description: activity.error ?? undefined,
    action: {
      label: i18n.t('activity.openPanel'),
      onClick: () => useActivityPanelStore.getState().openOn('activity'),
    },
  });
}
