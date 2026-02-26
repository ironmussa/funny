import type { Thread, ThreadStatus } from '@funny/shared';
import { History, ChevronRight } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { timeAgo } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { ThreadItem } from './ThreadItem';

const FINISHED_STATUSES: ThreadStatus[] = ['completed', 'failed', 'stopped', 'interrupted'];

interface FinishedThread extends Thread {
  projectName: string;
  projectPath: string;
  projectColor?: string;
}

interface RecentThreadsProps {
  onArchiveThread: (
    threadId: string,
    projectId: string,
    title: string,
    isWorktree: boolean,
  ) => void;
  onDeleteThread: (threadId: string, projectId: string, title: string, isWorktree: boolean) => void;
}

export function RecentThreads({ onArchiveThread, onDeleteThread }: RecentThreadsProps) {
  const { t } = useTranslation();
  useMinuteTick();
  const navigate = useNavigate();
  const threadsByProject = useThreadStore((s) => s.threadsByProject);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const projects = useProjectStore((s) => s.projects);
  const gitStatusByThread = useGitStatusStore((s) => s.statusByThread);
  const [isExpanded, setIsExpanded] = useState(true);

  const { recentThreads, totalCount } = useMemo(() => {
    const result: FinishedThread[] = [];
    const projectMap = new Map(
      projects.map((p) => [p.id, { name: p.name, path: p.path, color: p.color }]),
    );

    for (const [projectId, threads] of Object.entries(threadsByProject)) {
      for (const thread of threads) {
        if (FINISHED_STATUSES.includes(thread.status) && !thread.archived) {
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

    result.sort((a, b) => {
      const dateA = a.completedAt ?? a.createdAt;
      const dateB = b.completedAt ?? b.createdAt;
      return new Date(dateB).getTime() - new Date(dateA).getTime();
    });

    return { recentThreads: result.slice(0, 5), totalCount: result.length };
  }, [threadsByProject, projects]);

  // Eagerly fetch git status for visible worktree threads that don't have it yet
  useEffect(() => {
    const { fetchForThread, statusByThread } = useGitStatusStore.getState();
    for (const thread of recentThreads) {
      if (thread.mode === 'worktree' && !statusByThread[thread.id]) {
        fetchForThread(thread.id);
      }
    }
  }, [recentThreads]);

  if (recentThreads.length === 0) return null;

  return (
    <Collapsible open={isExpanded} onOpenChange={setIsExpanded} className="mb-1 min-w-0">
      <CollapsibleTrigger className="flex w-full min-w-0 items-center gap-1.5 px-2 py-1.5 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
        <ChevronRight
          className={cn(
            'h-3 w-3 flex-shrink-0 transition-transform duration-200',
            isExpanded && 'rotate-90',
          )}
        />
        <History className="h-3.5 w-3.5 flex-shrink-0" />
        <span className="truncate font-medium">{t('sidebar.recentThreads')}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="data-[state=open]:animate-slide-down">
        <div className="ml-3 mt-0.5 min-w-0 space-y-0.5 pl-1">
          {recentThreads.map((thread) => (
            <ThreadItem
              key={thread.id}
              thread={thread}
              projectPath={thread.projectPath}
              isSelected={selectedThreadId === thread.id}
              subtitle={thread.projectName}
              projectColor={thread.projectColor}
              timeValue={timeAgo(thread.completedAt ?? thread.createdAt, t)}
              gitStatus={thread.mode === 'worktree' ? gitStatusByThread[thread.id] : undefined}
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
              onArchive={() =>
                onArchiveThread(
                  thread.id,
                  thread.projectId,
                  thread.title,
                  thread.mode === 'worktree' && !!thread.branch && thread.provider !== 'external',
                )
              }
              onDelete={() =>
                onDeleteThread(
                  thread.id,
                  thread.projectId,
                  thread.title,
                  thread.mode === 'worktree' && !!thread.branch && thread.provider !== 'external',
                )
              }
            />
          ))}
          {totalCount > 5 && (
            <button
              onClick={() => navigate('/search?status=completed,failed,stopped,interrupted')}
              className="px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {t('sidebar.viewAll')}
            </button>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
