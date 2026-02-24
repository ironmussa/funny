import { useEffect, useMemo, useCallback, memo, startTransition } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useThreadStore } from '@/stores/thread-store';
import { useProjectStore } from '@/stores/project-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { timeAgo } from '@/lib/thread-utils';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { ThreadItem } from './ThreadItem';
import type { Thread, ThreadStatus, GitStatusInfo } from '@funny/shared';

const RUNNING_STATUSES = new Set<ThreadStatus>(['running', 'waiting', 'pending']);
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

  // Read the full statusByThread and pick only visible entries via useMemo.
  // Individual GitStatusInfo references are stable (only change when that
  // thread's status actually updates), so ThreadItem memo is not defeated.
  const statusByThread = useGitStatusStore((s) => s.statusByThread);
  const gitStatusByThread = useMemo(() => {
    const result: Record<string, GitStatusInfo> = {};
    for (const t of threads) {
      if (t.mode === 'worktree' && statusByThread[t.id]) {
        result[t.id] = statusByThread[t.id];
      }
    }
    return result;
  }, [threads, statusByThread]);

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

  // Stable callbacks that avoid creating new closures per thread inside .map().
  // ThreadItem is memo'd, so stable references prevent unnecessary re-renders.
  const handleSelect = useCallback((threadId: string, projectId: string) => {
    startTransition(() => {
      const store = useThreadStore.getState();
      if (store.selectedThreadId === threadId && (!store.activeThread || store.activeThread.id !== threadId)) {
        store.selectThread(threadId);
      }
      navigate(`/projects/${projectId}/threads/${threadId}`);
    });
  }, [navigate]);

  const handleArchive = useCallback((thread: EnrichedThread) => {
    onArchiveThread(thread.id, thread.projectId, thread.title, thread.mode === 'worktree' && !!thread.branch && thread.provider !== 'external');
  }, [onArchiveThread]);

  const handleDelete = useCallback((thread: EnrichedThread) => {
    onDeleteThread(thread.id, thread.projectId, thread.title, thread.mode === 'worktree' && !!thread.branch && thread.provider !== 'external');
  }, [onDeleteThread]);

  if (threads.length === 0) return null;

  return (
    <div className="space-y-0.5 min-w-0">
      {threads.map((thread) => {
        const isRunning = RUNNING_STATUSES.has(thread.status);
        return (
          <ThreadListItem
            key={thread.id}
            thread={thread}
            isSelected={selectedThreadId === thread.id}
            isRunning={isRunning}
            gitStatus={thread.mode === 'worktree' ? gitStatusByThread[thread.id] : undefined}
            onSelect={handleSelect}
            onArchive={thread.status === 'running' ? undefined : handleArchive}
            onDelete={thread.status === 'running' ? undefined : handleDelete}
            t={t}
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

// Wrapper that converts stable (threadId, projectId) callbacks into the
// parameterless callbacks that ThreadItem expects, memoized per thread.
const ThreadListItem = memo(function ThreadListItem({
  thread,
  isSelected,
  isRunning,
  gitStatus,
  onSelect,
  onArchive,
  onDelete,
  t,
}: {
  thread: EnrichedThread;
  isSelected: boolean;
  isRunning: boolean;
  gitStatus?: GitStatusInfo;
  onSelect: (threadId: string, projectId: string) => void;
  onArchive?: (thread: EnrichedThread) => void;
  onDelete?: (thread: EnrichedThread) => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const handleSelect = useCallback(() => onSelect(thread.id, thread.projectId), [onSelect, thread.id, thread.projectId]);
  const handleArchive = useMemo(() => onArchive ? () => onArchive(thread) : undefined, [onArchive, thread]);
  const handleDelete = useMemo(() => onDelete ? () => onDelete(thread) : undefined, [onDelete, thread]);

  return (
    <ThreadItem
      thread={thread}
      projectPath={thread.projectPath}
      isSelected={isSelected}
      subtitle={thread.projectName}
      projectColor={thread.projectColor}
      timeValue={isRunning ? undefined : timeAgo(thread.completedAt ?? thread.createdAt, t)}
      gitStatus={gitStatus}
      onSelect={handleSelect}
      onArchive={handleArchive}
      onDelete={handleDelete}
    />
  );
});
