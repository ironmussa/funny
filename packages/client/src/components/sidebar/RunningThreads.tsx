import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useThreadStore } from '@/stores/thread-store';
import { useProjectStore } from '@/stores/project-store';
import { cn } from '@/lib/utils';
import { ChevronRight } from 'lucide-react';
import { ThreadItem } from './ThreadItem';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import type { Thread } from '@funny/shared';
import { useGitStatusStore } from '@/stores/git-status-store';

interface RunningThread extends Thread {
  projectName: string;
  projectPath: string;
}

export function RunningThreads() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const threadsByProject = useThreadStore(s => s.threadsByProject);
  const selectedThreadId = useThreadStore(s => s.selectedThreadId);
  const projects = useProjectStore(s => s.projects);
  const gitStatusByThread = useGitStatusStore((s) => s.statusByThread);
  const [isExpanded, setIsExpanded] = useState(true);

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
    <Collapsible
      open={isExpanded}
      onOpenChange={setIsExpanded}
      className="mb-1 min-w-0"
    >
      <CollapsibleTrigger className="flex items-center gap-1.5 px-2 py-1.5 text-xs text-left text-muted-foreground hover:text-foreground min-w-0 transition-colors w-full">
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 transition-transform duration-200',
            isExpanded && 'rotate-90'
          )}
        />
        <span className="h-1.5 w-1.5 rounded-full bg-status-info animate-pulse flex-shrink-0" />
        <span className="truncate font-medium">{t('sidebar.activeThreads')} ({runningThreads.length})</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=open]:animate-slide-down">
        <div className="ml-3 pl-1 mt-0.5 space-y-0.5 min-w-0">
          {runningThreads.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              projectPath={thread.projectPath}
              isSelected={selectedThreadId === thread.id}
              subtitle={thread.projectName}
              gitStatus={thread.mode === 'worktree' ? gitStatusByThread[thread.id] : undefined}
              onSelect={() => {
                const store = useThreadStore.getState();
                if (store.selectedThreadId === thread.id && (!store.activeThread || store.activeThread.id !== thread.id)) {
                  store.selectThread(thread.id);
                }
                navigate(`/projects/${thread.projectId}/threads/${thread.id}`);
              }}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
