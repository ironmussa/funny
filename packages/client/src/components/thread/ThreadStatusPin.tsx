import type { Thread, ThreadStatus } from '@funny/shared';
import { Pin, PinOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { statusConfig } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { isThreadUnread, useThreadReadStore } from '@/stores/thread-read-store';

export type ThreadStatusPinHoverGroup = 'thread' | 'card' | 'row';

// Static Tailwind class maps — listed literally so Tailwind's scanner picks
// them up. Parent element must declare the matching `group/<name>` class.
const HIDE_ON_HOVER: Record<ThreadStatusPinHoverGroup, string> = {
  thread: 'group-hover/thread:hidden',
  card: 'group-hover/card:hidden',
  row: 'group-hover/row:hidden',
};

const SHOW_ON_HOVER: Record<ThreadStatusPinHoverGroup, string> = {
  thread: 'group-hover/thread:flex',
  card: 'group-hover/card:flex',
  row: 'group-hover/row:flex',
};

export interface ThreadStatusPinProps {
  thread: Thread;
  onPin?: (pinned: boolean) => void;
  hoverGroup: ThreadStatusPinHoverGroup;
  showStatusTooltip?: boolean;
  className?: string;
}

export function ThreadStatusPin({
  thread,
  onPin,
  hoverGroup,
  showStatusTooltip = false,
  className,
}: ThreadStatusPinProps) {
  const { t } = useTranslation();
  const cfg = statusConfig[thread.status as ThreadStatus] ?? statusConfig.pending;
  const StatusIcon = cfg.icon;
  const isBusy = thread.status === 'running' || thread.status === 'setting_up';
  const canPin = !!onPin;
  const showPinRest = canPin && thread.pinned && !isBusy;
  const hideOnHover = canPin ? HIDE_ON_HOVER[hoverGroup] : '';
  const showOnHover = SHOW_ON_HOVER[hoverGroup];
  const isUnread = useThreadReadStore((s) =>
    isThreadUnread(s.readAt, thread.id, thread.completedAt),
  );
  const showUnreadDot = isUnread && !isBusy && !showPinRest;

  const statusIcon = showStatusTooltip ? (
    <Tooltip>
      <TooltipTrigger asChild>
        <StatusIcon className={cn('icon-sm', cfg.className)} />
      </TooltipTrigger>
      <TooltipContent side="top" className="text-xs">
        {t(`thread.status.${thread.status}`)}
      </TooltipContent>
    </Tooltip>
  ) : (
    <StatusIcon className={cn('icon-sm', cfg.className)} />
  );

  return (
    <div className={cn('relative size-3.5 flex-shrink-0', className)}>
      {showPinRest ? (
        <span
          className={cn(
            'absolute inset-0 flex items-center justify-center text-muted-foreground',
            hideOnHover,
          )}
        >
          <Pin className="icon-sm" />
        </span>
      ) : showUnreadDot ? (
        <span
          className={cn('absolute inset-0 flex items-center justify-center', hideOnHover)}
          data-testid={`thread-unread-dot-${thread.id}`}
        >
          <span className="block size-2 rounded-full bg-blue-500" />
        </span>
      ) : (
        <span className={cn('absolute inset-0 flex items-center justify-center', hideOnHover)}>
          {statusIcon}
        </span>
      )}
      {canPin && (
        <span
          className={cn(
            'absolute inset-0 hidden cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground',
            showOnHover,
          )}
          onClick={(e) => {
            e.stopPropagation();
            onPin!(!thread.pinned);
          }}
          data-testid={`thread-pin-toggle-${thread.id}`}
        >
          {thread.pinned ? <PinOff className="icon-sm" /> : <Pin className="icon-sm" />}
        </span>
      )}
    </div>
  );
}
