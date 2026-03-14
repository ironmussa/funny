import type { Thread, ThreadStatus } from '@funny/shared';
import { History } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { useMinuteTick } from '@/hooks/use-minute-tick';
import { timeAgo } from '@/lib/thread-utils';
import { buildPath } from '@/lib/url';
import { useGitStatusStore, branchKey as computeBranchKey } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { ThreadGroup } from './ThreadGroup';
import { ThreadItem } from './ThreadItem';
import { ViewAllButton } from './ViewAllButton';

const FINISHED_STATUSES: ThreadStatus[] = ['completed', 'failed', 'stopped', 'interrupted'];

interface FinishedThread extends Thread {
  projectName: string;
  projectPath: string;
  projectColor?: string;
}

interface RecentThreadsProps {
  onRenameThread: (threadId: string, projectId: string, title: string) => void;
  onArchiveThread: (
    threadId: string,
    projectId: string,
    title: string,
    isWorktree: boolean,
  ) => void;
  onDeleteThread: (threadId: string, projectId: string, title: string, isWorktree: boolean) => void;
}

export function RecentThreads({
  onRenameThread,
  onArchiveThread,
  onDeleteThread,
}: RecentThreadsProps) {
  const { t } = useTranslation();
  useMinuteTick();
  const navigate = useNavigate();
  const threadsByProject = useThreadStore((s) => s.threadsByProject);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const projects = useProjectStore((s) => s.projects);
  const statusByBranch = useGitStatusStore((s) => s.statusByBranch);
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
    const { fetchForThread, statusByBranch: sbb } = useGitStatusStore.getState();
    for (const thread of recentThreads) {
      if (thread.mode === 'worktree') {
        const bk = computeBranchKey(thread);
        if (!sbb[bk]) {
          fetchForThread(thread.id);
        }
      }
    }
  }, [recentThreads]);

  if (recentThreads.length === 0) return null;

  return (
    <ThreadGroup
      title={t('sidebar.recentThreads')}
      icon={History}
      data-testid="sidebar-recent-threads"
    >
      {recentThreads.map((thread) => {
        return (
          <ThreadItem
            key={thread.id}
            thread={thread}
            projectPath={thread.projectPath}
            isSelected={selectedThreadId === thread.id}
            subtitle={thread.projectName}
            projectColor={thread.projectColor}
            timeValue={timeAgo(thread.completedAt ?? thread.createdAt, t)}
            gitStatus={statusByBranch[computeBranchKey(thread)]}
            onSelect={() => {
              const store = useThreadStore.getState();
              if (
                store.selectedThreadId === thread.id &&
                (!store.activeThread || store.activeThread.id !== thread.id)
              ) {
                store.selectThread(thread.id);
              }
              navigate(buildPath(`/projects/${thread.projectId}/threads/${thread.id}`));
            }}
            onRename={() => onRenameThread(thread.id, thread.projectId, thread.title)}
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
        );
      })}
      {totalCount > 5 && (
        <ViewAllButton
          onClick={() => navigate(buildPath('/list?status=completed,failed,stopped,interrupted'))}
        />
      )}
    </ThreadGroup>
  );
}
