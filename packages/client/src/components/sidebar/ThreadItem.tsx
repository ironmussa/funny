import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Archive,
  Trash2,
  MoreHorizontal,
  FolderOpenDot,
  Terminal,
  Square,
} from 'lucide-react';
import { statusConfig, timeAgo } from '@/lib/thread-utils';
import type { Thread, ThreadStatus } from '@a-parallel/shared';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api';

interface ThreadItemProps {
  thread: Thread;
  projectPath: string;
  isSelected: boolean;
  onSelect: () => void;
  subtitle?: string;
  timeValue?: string;
  onArchive?: () => void;
  onDelete?: () => void;
}

export function ThreadItem({ thread, projectPath, isSelected, onSelect, subtitle, timeValue, onArchive, onDelete }: ThreadItemProps) {
  const { t } = useTranslation();
  const [openDropdown, setOpenDropdown] = useState(false);

  const s = statusConfig[thread.status as ThreadStatus] ?? statusConfig.pending;
  const Icon = s.icon;
  const isRunning = thread.status === 'running' || thread.status === 'waiting';
  const displayTime = timeValue ?? timeAgo(thread.createdAt, t);

  return (
    <div
      className={cn(
        'group/thread w-full flex items-stretch rounded-md transition-colors min-w-0',
        isSelected
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
      )}
    >
      <button
        onClick={onSelect}
        className="flex-1 flex items-center gap-1.5 pl-2 py-1.5 text-left min-w-0 overflow-hidden"
      >
        <Icon className={cn('h-3 w-3 flex-shrink-0', s.className)} />
        <div className="flex flex-col gap-0 min-w-0 flex-1">
          <span className="text-[11px] leading-tight truncate">{thread.title}</span>
          {subtitle && (
            <span className="text-[10px] text-muted-foreground truncate">{subtitle}</span>
          )}
        </div>
      </button>
      <div className="flex-shrink-0 pr-1.5 pl-2 flex items-start justify-end py-1.5 min-w-[2.5rem]">
        <span className={cn(
          'text-[10px] text-muted-foreground leading-4 h-4 group-hover/thread:hidden',
          openDropdown && 'hidden'
        )}>
          {displayTime}
        </span>
        <div className={cn(
          'hidden group-hover/thread:flex items-center h-4',
          openDropdown && '!flex'
        )}>
          <DropdownMenu onOpenChange={setOpenDropdown}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                onClick={(e) => e.stopPropagation()}
                className="text-muted-foreground hover:text-foreground"
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" side="left">
              <DropdownMenuItem
                onClick={async (e) => {
                  e.stopPropagation();
                  const folderPath = thread.worktreePath || projectPath;
                  try {
                    await fetch('/api/browse/open-directory', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ path: folderPath }),
                    });
                  } catch (error) {
                    console.error('Failed to open directory:', error);
                  }
                }}
              >
                <FolderOpenDot className="h-3.5 w-3.5" />
                {t('sidebar.openDirectory')}
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={async (e) => {
                  e.stopPropagation();
                  const folderPath = thread.worktreePath || projectPath;
                  try {
                    await fetch('/api/browse/open-terminal', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ path: folderPath }),
                    });
                  } catch (error) {
                    console.error('Failed to open terminal:', error);
                  }
                }}
              >
                <Terminal className="h-3.5 w-3.5" />
                {t('sidebar.openTerminal')}
              </DropdownMenuItem>
              {isRunning ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onClick={async (e) => {
                      e.stopPropagation();
                      try {
                        await api.stopThread(thread.id);
                      } catch (error) {
                        console.error('Failed to stop thread:', error);
                      }
                    }}
                    className="text-red-400 focus:text-red-400"
                  >
                    <Square className="h-3.5 w-3.5" />
                    {t('common.stop')}
                  </DropdownMenuItem>
                </>
              ) : (
                <>
                  {onArchive && (
                    <DropdownMenuItem
                      onClick={(e) => {
                        e.stopPropagation();
                        onArchive();
                      }}
                    >
                      <Archive className="h-3.5 w-3.5" />
                      {t('sidebar.archive')}
                    </DropdownMenuItem>
                  )}
                  {onDelete && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        onClick={(e) => {
                          e.stopPropagation();
                          onDelete();
                        }}
                        className="text-red-400 focus:text-red-400"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                        {t('common.delete')}
                      </DropdownMenuItem>
                    </>
                  )}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
