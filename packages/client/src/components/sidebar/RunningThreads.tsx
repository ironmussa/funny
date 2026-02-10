import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useThreadStore } from '@/stores/thread-store';
import { useProjectStore } from '@/stores/project-store';
import { cn } from '@/lib/utils';
import { statusConfig } from '@/lib/thread-utils';
import type { Thread, ThreadStatus } from '@a-parallel/shared';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  MoreHorizontal,
  FolderOpenDot,
  Terminal,
  Square,
} from 'lucide-react';
import { api } from '@/lib/api';

interface RunningThread extends Thread {
  projectName: string;
  projectPath: string;
}

interface RunningThreadItemProps {
  thread: RunningThread;
  isSelected: boolean;
  navigate: (path: string) => void;
}

function RunningThreadItem({ thread, isSelected, navigate }: RunningThreadItemProps) {
  const { t } = useTranslation();
  const [openDropdown, setOpenDropdown] = useState(false);

  const s = statusConfig[thread.status as ThreadStatus] ?? statusConfig.running;
  const Icon = s.icon;

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
        onClick={() => {
          const store = useThreadStore.getState();
          if (store.selectedThreadId === thread.id && (!store.activeThread || store.activeThread.id !== thread.id)) {
            store.selectThread(thread.id);
          }
          navigate(`/projects/${thread.projectId}/threads/${thread.id}`);
        }}
        className="flex-1 flex items-center gap-1.5 px-2 py-1.5 text-left min-w-0"
      >
        <Icon className={cn('h-3 w-3 flex-shrink-0', s.className)} />
        <div className="flex flex-col gap-0 min-w-0 flex-1">
          <span className="text-[11px] leading-tight truncate">{thread.title}</span>
          <span className="text-[10px] text-muted-foreground truncate">{thread.projectName}</span>
        </div>
      </button>
      <div className="flex-shrink-0 pr-1 flex items-center">
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
                  const folderPath = thread.worktreePath || thread.projectPath;
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
                  const folderPath = thread.worktreePath || thread.projectPath;
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
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </div>
  );
}

export function RunningThreads() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const threadsByProject = useThreadStore(s => s.threadsByProject);
  const selectedThreadId = useThreadStore(s => s.selectedThreadId);
  const projects = useProjectStore(s => s.projects);

  const runningThreads = useMemo(() => {
    const result: RunningThread[] = [];
    const projectMap = new Map(projects.map(p => [p.id, { name: p.name, path: p.path }]));

    for (const [projectId, threads] of Object.entries(threadsByProject)) {
      for (const thread of threads) {
        if (thread.status === 'running' || thread.status === 'waiting') {
          const project = projectMap.get(projectId);
          result.push({
            ...thread,
            projectName: project?.name ?? projectId,
            projectPath: project?.path ?? '',
          });
        }
      }
    }
    return result;
  }, [threadsByProject, projects]);

  if (runningThreads.length === 0) return null;

  return (
    <div className="px-2 pb-1">
      <div className="flex items-center gap-1.5 px-2 py-1.5 text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
        <span className="h-1.5 w-1.5 rounded-full bg-blue-400 animate-pulse" />
        {t('sidebar.activeThreads')} ({runningThreads.length})
      </div>
      <div className="space-y-0.5">
        {runningThreads.map((thread) => <RunningThreadItem key={thread.id} thread={thread} isSelected={selectedThreadId === thread.id} navigate={navigate} />)}
      </div>
    </div>
  );
}
