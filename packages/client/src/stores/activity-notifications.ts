import type { Activity } from '@funny/shared';
import { toast } from 'sonner';

import i18n from '@/i18n/config';

import { useActivityPanelStore } from './activity-panel-store';

/**
 * The toast for an activity that just failed (track-background-activities):
 * names it and offers to open the activity panel. Raised from the realtime
 * update only, never from a list load.
 */
export function notifyActivityFailed(activity: Activity): void {
  toast.error(i18n.t('activity.failedToast', { title: activity.title }), {
    id: `activity-failed-${activity.id}`,
    description: activity.error ?? undefined,
    action: {
      label: i18n.t('activity.openPanel'),
      onClick: () => useActivityPanelStore.getState().openOn('activity'),
    },
  });
}
