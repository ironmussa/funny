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
import { api } from '@/lib/api';

interface ThreadItemProps {
  thread: Thread;
  projectId: string;
  projectPath: string;
  isSelected: boolean;
  onSelect: () => void;
  onArchive: () => void;
  onDelete: () => void;
}

export function ThreadItem({ thread, projectId, projectPath, isSelected, onSelect, onArchive, onDelete }: ThreadItemProps) {
  const { t } = useTranslation();
  const [openDropdown, setOpenDropdown] = useState(false);

  const s = statusConfig[thread.status as ThreadStatus] ?? statusConfig.pending;
  const Icon = s.icon;
  const isRunning = thread.status === 'running' || thread.status === 'waiting';

  return (
    <div
      className={cn(
        'group/thread flex items-center rounded-md transition-colors min-w-0',
        isSelected
          ? 'bg-accent text-accent-foreground'
          : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground'
      )}
    >
      <button
        onClick={onSelect}
        className="flex-1 flex flex-col gap-0.5 pl-2 py-1.5 text-left min-w-0"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon className={cn('h-3 w-3 flex-shrink-0', s.className)} />
          <span className="text-[11px] leading-tight truncate">{thread.title}</span>
        </div>
        {thread.branch && (
          <div className="flex items-center gap-1 ml-[18px] min-w-0">
            <span className="text-[10px] text-muted-foreground truncate">
              {thread.branch.includes('/') ? thread.branch.split('/').slice(1).join('/') : thread.branch}
            </span>
            {thread.baseBranch && (
              <span className="text-[10px] text-muted-foreground/50 flex-shrink-0">
                from {thread.baseBranch}
              </span>
            )}
          </div>
        )}
      </button>
      <div className="flex-shrink-0 pr-1 flex items-center">
        <span className={cn(
          'text-[10px] text-muted-foreground group-hover/thread:hidden',
          openDropdown && 'hidden'
        )}>
          {timeAgo(thread.createdAt, t)}
        </span>
        <div className={cn(
          'hidden group-hover/thread:flex items-center',
          openDropdown && '!flex'
        )}>
          <DropdownMenu onOpenChange={setOpenDropdown}>
            <DropdownMenuTrigger asChild>
              <button
                onClick={(e) => e.stopPropagation()}
                className="text-muted-foreground hover:text-foreground transition-colors p-0.5 rounded-sm hover:bg-accent"
              >
                <MoreHorizontal className="h-3 w-3" />
              </button>
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
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onArchive();
                    }}
                  >
                    <Archive className="h-3.5 w-3.5" />
                    {t('sidebar.archive')}
                  </DropdownMenuItem>
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
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}
