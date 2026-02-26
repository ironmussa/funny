import type { ThreadStatus } from '@funny/shared';
import { useTranslation } from 'react-i18next';

import { getStatusLabels } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';

const badgeStyles: Record<ThreadStatus, string> = {
  idle: 'bg-status-neutral/10 text-status-neutral/80',
  pending: 'bg-status-pending/10 text-status-pending/80',
  running: 'bg-status-info/10 text-status-info/80',
  waiting: 'bg-status-warning/10 text-status-warning/80',
  completed: 'bg-status-success/10 text-status-success/80',
  failed: 'bg-status-error/10 text-status-error/80',
  stopped: 'bg-status-neutral/10 text-status-neutral/80',
  interrupted: 'bg-status-interrupted/10 text-status-interrupted/80',
};

export function StatusBadge({ status }: { status: ThreadStatus }) {
  const { t } = useTranslation();
  const style = badgeStyles[status] ?? badgeStyles.pending;
  const statusLabels = { ...getStatusLabels(t), completed: t('thread.status.done') };

  return (
    <span
      className={cn('inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium', style)}
    >
      {status === 'running' && (
        <span className="mr-1 h-1.5 w-1.5 animate-pulse rounded-full bg-status-info" />
      )}
      {status === 'waiting' && (
        <span className="mr-1 h-1.5 w-1.5 animate-pulse rounded-full bg-status-warning" />
      )}
      {statusLabels[status]}
    </span>
  );
}
