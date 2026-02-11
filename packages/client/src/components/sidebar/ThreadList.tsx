import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useThreadStore } from '@/stores/thread-store';
import { useProjectStore } from '@/stores/project-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { timeAgo } from '@/lib/thread-utils';
import { ThreadItem } from './ThreadItem';
import type { Thread, ThreadStatus } from '@a-parallel/shared';

const RUNNING_STATUSES: ThreadStatus[] = ['running', 'waiting'];
const FINISHED_STATUSES: ThreadStatus[] = ['completed', 'failed', 'stopped', 'interrupted'];
const VISIBLE_STATUSES = [...RUNNING_STATUSES, ...FINISHED_STATUSES];

interface EnrichedThread extends Thread {
  projectName: string;
  projectPath: string;
}

interface ThreadListProps {
  onArchiveThread: (threadId: string, projectId: string, title: string, isWorktree: boolean) => void;
  onDeleteThread: (threadId: string, projectId: string, title: string, isWorktree: boolean) => void;
}

export function ThreadList({ onArchiveThread, onDeleteThread }: ThreadListProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const threadsByProject = useThreadStore(s => s.threadsByProject);
  const selectedThreadId = useThreadStore(s => s.selectedThreadId);
  const projects = useProjectStore(s => s.projects);
  const gitStatusByThread = useGitStatusStore(s => s.statusByThread);

  const threads = useMemo(() => {
    const result: EnrichedThread[] = [];
    const projectMap = new Map(projects.map(p => [p.id, { name: p.name, path: p.path }]));

    for (const [projectId, projectThreads] of Object.entries(threadsByProject)) {
      for (const thread of projectThreads) {
        if (VISIBLE_STATUSES.includes(thread.status)) {
          const project = projectMap.get(projectId);
          result.push({
            ...thread,
            projectName: project?.name ?? projectId,
            projectPath: project?.path ?? '',
          });
        }
      }
    }

    // Sort: running/waiting first, then by date descending
    result.sort((a, b) => {
      const aRunning = RUNNING_STATUSES.includes(a.status) ? 1 : 0;
      const bRunning = RUNNING_STATUSES.includes(b.status) ? 1 : 0;
      if (aRunning !== bRunning) return bRunning - aRunning;
      const dateA = a.completedAt ?? a.createdAt;
      const dateB = b.completedAt ?? b.createdAt;
      return new Date(dateB).getTime() - new Date(dateA).getTime();
    });

    // Limit finished threads to 5, keep all running
    const running = result.filter(t => RUNNING_STATUSES.includes(t.status));
    const finished = result.filter(t => !RUNNING_STATUSES.includes(t.status)).slice(0, 5);
    return [...running, ...finished];
  }, [threadsByProject, projects]);

  if (threads.length === 0) return null;

  return (
    <div className="space-y-0.5 min-w-0">
      {threads.map((thread) => {
        const isRunning = RUNNING_STATUSES.includes(thread.status);
        return (
          <ThreadItem
            key={thread.id}
            thread={thread}
            projectPath={thread.projectPath}
            isSelected={selectedThreadId === thread.id}
            subtitle={thread.projectName}
            timeValue={isRunning ? undefined : timeAgo(thread.completedAt ?? thread.createdAt, t)}
            gitStatus={thread.mode === 'worktree' ? gitStatusByThread[thread.id] : undefined}
            onSelect={() => {
              const store = useThreadStore.getState();
              if (store.selectedThreadId === thread.id && (!store.activeThread || store.activeThread.id !== thread.id)) {
                store.selectThread(thread.id);
              }
              navigate(`/projects/${thread.projectId}/threads/${thread.id}`);
            }}
            onArchive={isRunning ? undefined : () => onArchiveThread(thread.id, thread.projectId, thread.title, thread.mode === 'worktree' && !!thread.branch)}
            onDelete={isRunning ? undefined : () => onDeleteThread(thread.id, thread.projectId, thread.title, thread.mode === 'worktree' && !!thread.branch)}
          />
        );
      })}
    </div>
  );
}
