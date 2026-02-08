import { cn } from '@/lib/utils';
import type { ThreadStatus } from '@a-parallel/shared';

const statusConfig: Record<
  ThreadStatus,
  { label: string; className: string }
> = {
  pending: { label: 'Pending', className: 'bg-yellow-500/20 text-yellow-400' },
  running: { label: 'Running', className: 'bg-blue-500/20 text-blue-400' },
  completed: { label: 'Done', className: 'bg-green-500/20 text-green-400' },
  failed: { label: 'Failed', className: 'bg-red-500/20 text-red-400' },
  stopped: { label: 'Stopped', className: 'bg-gray-500/20 text-gray-400' },
};

export function StatusBadge({ status }: { status: ThreadStatus }) {
  const config = statusConfig[status] ?? statusConfig.pending;

  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        config.className
      )}
    >
      {status === 'running' && (
        <span className="mr-1 h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
      )}
      {config.label}
    </span>
  );
}
