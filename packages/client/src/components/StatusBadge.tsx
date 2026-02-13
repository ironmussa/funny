import { cn } from '@/lib/utils';
import { useTranslation } from 'react-i18next';
import { getStatusLabels } from '@/lib/thread-utils';
import type { ThreadStatus } from '@a-parallel/shared';

const badgeStyles: Record<ThreadStatus, string> = {
  idle: 'bg-gray-500/20 text-gray-400',
  pending: 'bg-yellow-500/20 text-yellow-400',
  running: 'bg-blue-500/20 text-blue-400',
  waiting: 'bg-amber-500/20 text-amber-400',
  completed: 'bg-green-500/20 text-green-400',
  failed: 'bg-red-500/20 text-red-400',
  stopped: 'bg-gray-500/20 text-gray-400',
  interrupted: 'bg-orange-500/20 text-orange-400',
};

export function StatusBadge({ status }: { status: ThreadStatus }) {
  const { t } = useTranslation();
  const style = badgeStyles[status] ?? badgeStyles.pending;
  const statusLabels = { ...getStatusLabels(t), completed: t('thread.status.done') };

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        style
      )}
    >
      {status === 'running' && (
        <span className="mr-1 h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
      )}
      {status === 'waiting' && (
        <span className="mr-1 h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
      )}
      {statusLabels[status]}
    </span>
  );
}
