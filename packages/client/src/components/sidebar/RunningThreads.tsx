import type { Thread } from '@funny/shared';
import { ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { ThreadItem } from './ThreadItem';

interface RunningThread extends Thread {
  projectName: string;
  projectPath: string;
  projectColor?: string;
}

export function RunningThreads() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const threadsByProject = useThreadStore((s) => s.threadsByProject);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const projects = useProjectStore((s) => s.projects);
  const gitStatusByThread = useGitStatusStore((s) => s.statusByThread);
  const [isExpanded, setIsExpanded] = useState(true);

  const runningThreads = useMemo(() => {
    const result: RunningThread[] = [];
    const projectMap = new Map(
      projects.map((p) => [p.id, { name: p.name, path: p.path, color: p.color }]),
    );

    for (const [projectId, threads] of Object.entries(threadsByProject)) {
      for (const thread of threads) {
        if (thread.status === 'running' || thread.status === 'waiting') {
          const project = projectMap.get(projectId);
          result.push({
            ...thread,
            projectName: project?.name ?? projectId,
            projectPath: project?.path ?? '',
            projectColor: project?.color,
          });
        }
      }
    }
    return result;
  }, [threadsByProject, projects]);

  // Eagerly fetch git status for visible worktree threads that don't have it yet
  useEffect(() => {
    const { fetchForThread, statusByThread } = useGitStatusStore.getState();
    for (const thread of runningThreads) {
      if (thread.mode === 'worktree' && !statusByThread[thread.id]) {
        fetchForThread(thread.id);
      }
    }
  }, [runningThreads]);

  if (runningThreads.length === 0) return null;

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded} className="mb-1 min-w-0">
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 transition-transform duration-200',
            isExpanded && 'rotate-90',
          )}
        />
        <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-status-info" />
        <span className="truncate font-medium">
          {t('sidebar.activeThreads')} ({runningThreads.length})
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=open]:animate-slide-down">
        <div className="mt-0.5 min-w-0 space-y-0.5">
          {runningThreads.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              projectPath={thread.projectPath}
              isSelected={selectedThreadId === thread.id}
              subtitle={thread.projectName}
              projectColor={thread.projectColor}
              gitStatus={gitStatusByThread[thread.id]}
              onSelect={() => {
                const store = useThreadStore.getState();
                if (
                  store.selectedThreadId === thread.id &&
                  (!store.activeThread || store.activeThread.id !== thread.id)
                ) {
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
