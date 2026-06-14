import type { ThreadStatus } from '@funny/shared';
import { useTranslation } from 'react-i18next';

import { getDisplayThreadStatus, getStatusLabels, statusConfig } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { useRunnerStatusStore } from '@/stores/runner-status-store';

export function StatusBadge({ status }: { status: ThreadStatus }) {
  const { t } = useTranslation();
  const runnerStatus = useRunnerStatusStore((s) => s.status);
  // Mirror desktop: a running thread on a dead runner shows as runner_offline,
  // and the icon/color come from the shared statusConfig source of truth.
  const displayStatus = getDisplayThreadStatus(status, runnerStatus);
  const cfg = statusConfig[displayStatus] ?? statusConfig.pending;
  const Icon = cfg.icon;
  // Color class without the spin animation — the spin belongs on the icon only,
  // not on the whole badge (and its text label).
  const colorClass = cfg.className
    .split(' ')
    .filter((c) => c !== 'animate-spin')
    .join(' ');
  const statusLabels = { ...getStatusLabels(t), completed: t('thread.status.done') };

  return (
    <span
      className={cn(
        'bg-muted/50 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        colorClass,
      )}
    >
      <Icon className={cn('size-3 shrink-0', cfg.className)} />
      {statusLabels[displayStatus]}
    </span>
  );
}
