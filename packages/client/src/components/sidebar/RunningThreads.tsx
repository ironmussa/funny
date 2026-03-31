import type { Thread } from '@funny/shared';
import { useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { buildPath } from '@/lib/url';
import { useGitStatusStore, branchKey as computeBranchKey } from '@/stores/git-status-store';
import { useProjectStore } from '@/stores/project-store';
import { useThreadStore } from '@/stores/thread-store';

import { ThreadGroup } from './ThreadGroup';
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
  const statusByBranch = useGitStatusStore((s) => s.statusByBranch);
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

  // Eagerly fetch git status for visible worktree threads that don't have it yet.
  // Uses ensureStatusForThreads to deduplicate by branchKey across all callers.
  useEffect(() => {
    const worktreeThreads = runningThreads.filter((t) => t.mode === 'worktree');
    if (worktreeThreads.length > 0) {
      useGitStatusStore.getState().ensureStatusForThreads(worktreeThreads);
    }
  }, [runningThreads]);

  if (runningThreads.length === 0) return null;

  return (
    <ThreadGroup
      title={t('sidebar.activeThreads')}
      count={runningThreads.length}
      iconElement={
        <span className="h-1.5 w-1.5 flex-shrink-0 animate-pulse rounded-full bg-status-info" />
      }
      data-testid="sidebar-running-threads"
    >
      {runningThreads.map((thread) => {
        return (
          <ThreadItem
            key={thread.id}
            thread={thread}
            projectPath={thread.projectPath}
            isSelected={selectedThreadId === thread.id}
            subtitle={thread.projectName}
            projectColor={thread.projectColor}
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
          />
        );
      })}
    </ThreadGroup>
  );
}
