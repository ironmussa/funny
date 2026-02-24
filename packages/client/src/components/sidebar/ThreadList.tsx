import { useEffect, useMemo, startTransition } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useThreadStore } from '@/stores/thread-store';
import { useProjectStore } from '@/stores/project-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { timeAgo } from '@/lib/thread-utils';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { ThreadItem } from './ThreadItem';
import type { Thread, ThreadStatus } from '@funny/shared';

const RUNNING_STATUSES = new Set<ThreadStatus>(['running', 'waiting']);
const FINISHED_STATUSES = new Set<ThreadStatus>(['completed', 'failed', 'stopped', 'interrupted']);
const VISIBLE_STATUSES = new Set<ThreadStatus>([...RUNNING_STATUSES, ...FINISHED_STATUSES]);

interface EnrichedThread extends Thread {
  projectName: string;
  projectPath: string;
  projectColor?: string;
}

interface ThreadListProps {
  onArchiveThread: (threadId: string, projectId: string, title: string, isWorktree: boolean) => void;
  onDeleteThread: (threadId: string, projectId: string, title: string, isWorktree: boolean) => void;
}

export function ThreadList({ onArchiveThread, onDeleteThread }: ThreadListProps) {
  const { t } = useTranslation();
  useMinuteTick(); // re-render every 60s so timeAgo stays fresh
  const navigate = useNavigate();
  const threadsByProject = useThreadStore(s => s.threadsByProject);
  const selectedThreadId = useThreadStore(s => s.selectedThreadId);
  const projects = useProjectStore(s => s.projects);
  const gitStatusByThread = useGitStatusStore(s => s.statusByThread);

  const { threads, totalCount } = useMemo(() => {
    const result: EnrichedThread[] = [];
    const projectMap = new Map(projects.map(p => [p.id, { name: p.name, path: p.path, color: p.color }]));

    for (const [projectId, projectThreads] of Object.entries(threadsByProject)) {
      for (const thread of projectThreads) {
        if (VISIBLE_STATUSES.has(thread.status) && !thread.archived) {
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

    // Sort: running/waiting first, then by date descending
    result.sort((a, b) => {
      const aRunning = RUNNING_STATUSES.has(a.status) ? 1 : 0;
      const bRunning = RUNNING_STATUSES.has(b.status) ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      const dateA = a.completedAt ?? a.createdAt;
      const dateB = b.completedAt ?? b.createdAt;
      return new Date(dateB).getTime() - new Date(dateA).getTime();
    });

    // Always show at most 5 threads total, prioritizing running ones
    return { threads: result.slice(0, 5), totalCount: result.length };
  }, [threadsByProject, projects]);

  // Eagerly fetch git status for visible worktree threads that don't have it yet.
  // This ensures icons show up in the global thread list without requiring a click.
  useEffect(() => {
    const { fetchForThread, statusByThread } = useGitStatusStore.getState();
    for (const thread of threads) {
      if (thread.mode === 'worktree' && !statusByThread[thread.id]) {
        fetchForThread(thread.id);
      }
    }
  }, [threads]);

  if (threads.length === 0) return null;

  return (
    <div className="space-y-0.5 min-w-0">
      {threads.map((thread) => {
        const isRunning = RUNNING_STATUSES.has(thread.status);
        return (
          <ThreadItem
            key={thread.id}
            thread={thread}
            projectPath={thread.projectPath}
            isSelected={selectedThreadId === thread.id}
            subtitle={thread.projectName}
            projectColor={thread.projectColor}
            timeValue={isRunning ? undefined : timeAgo(thread.completedAt ?? thread.createdAt, t)}
            gitStatus={thread.mode === 'worktree' ? gitStatusByThread[thread.id] : undefined}
            onSelect={() => {
              startTransition(() => {
                const store = useThreadStore.getState();
                if (store.selectedThreadId === thread.id && (!store.activeThread || store.activeThread.id !== thread.id)) {
                  store.selectThread(thread.id);
                }
                navigate(`/projects/${thread.projectId}/threads/${thread.id}`);
              });
            }}
            onArchive={thread.status === 'running' ? undefined : () => onArchiveThread(thread.id, thread.projectId, thread.title, thread.mode === 'worktree' && !!thread.branch && thread.provider !== 'external')}
            onDelete={thread.status === 'running' ? undefined : () => onDeleteThread(thread.id, thread.projectId, thread.title, thread.mode === 'worktree' && !!thread.branch && thread.provider !== 'external')}
          />
        );
      })}
      {totalCount > 5 && (
        <button
          onClick={() => navigate('/search?status=completed,failed,stopped,interrupted')}
          className="text-sm text-muted-foreground hover:text-foreground px-2 py-1.5 transition-colors"
        >
          {t('sidebar.viewAll')}
        </button>
      )}
    </div>
  );
}
