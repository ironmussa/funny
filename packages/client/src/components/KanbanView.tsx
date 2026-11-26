import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import { monitorForElements } from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { Thread, ThreadStage, GitStatusInfo } from '@funny/shared';
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { KanbanColumn } from '@/components/kanban/KanbanColumn';
import { SlideUpPrompt } from '@/components/SlideUpPrompt';
import { toast } from '@/components/ui/toast';
import { useGitStatusMaps } from '@/data/git-status/hooks';
import { branchKey as computeBranchKey } from '@/data/git-status/keys';
import { useProjects } from '@/data/projects/hooks';
import { useProjectThreadMode } from '@/data/runner/hooks';
import { groupThreadsByStage } from '@/data/threads/views';
import { useGitStatusScope } from '@/hooks/use-git-status-scope';
import { useThreadCreation } from '@/hooks/use-thread-creation';
import { stageConfig } from '@/lib/thread-utils';
import { buildPath } from '@/lib/url';
import { resolveThreadBranch } from '@/lib/utils';
import { whilePending } from '@/lib/while-pending';
import { useSettingsStore } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';

interface KanbanViewProps {
  threads: Thread[];
  projectId?: string;
  search?: string;
  caseSensitive?: boolean;
  contentSnippets?: Map<string, string>;
  highlightThreadId?: string;
}

const STAGES: ThreadStage[] = ['backlog', 'planning', 'in_progress', 'review', 'done', 'archived'];

export function KanbanView({
  threads,
  projectId,
  search,
  caseSensitive,
  contentSnippets,
  highlightThreadId: initialHighlightId,
}: KanbanViewProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const updateThreadStage = useThreadStore((s) => s.updateThreadStage);
  const archiveThread = useThreadStore((s) => s.archiveThread);
  const unarchiveThread = useThreadStore((s) => s.unarchiveThread);
  const deleteThread = useThreadStore((s) => s.deleteThread);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const projects = useProjects();
  const loadThreadsForProject = useThreadStore((s) => s.loadThreadsForProject);
  const toolPermissions = useSettingsStore((s) => s.toolPermissions);

  const [deleteConfirm, setDeleteConfirm] = useState<{
    threadId: string;
    projectId: string;
    title: string;
    isWorktree?: boolean;
  } | null>(null);

  const [slideUpOpen, setSlideUpOpen] = useState(false);
  const [slideUpProjectId, setSlideUpProjectId] = useState<string | undefined>(undefined);
  const [slideUpStage, setSlideUpStage] = useState<ThreadStage>('backlog');
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [mergeWarning, setMergeWarning] = useState<{
    threadId: string;
    title: string;
    sourceStage: ThreadStage;
    newStage: ThreadStage;
    gitState: string;
  } | null>(null);
  const { statusByBranch: _statusByBranch, threadToBranchKey: _threadToBranchKey } =
    useGitStatusMaps();
  // Every card shows git state — request the whole project, not the sidebar rows.
  useGitStatusScope({
    all: true,
    projectIds: projectId ? [projectId] : [...new Set(threads.map((t) => t.projectId))],
  });
  // Resolve branch-keyed statuses to a threadId-keyed map for child components.
  // Prefer server-provided threadToBranchKey mapping (stable across thread data
  // refreshes) and fall back to client-side computation for threads not yet mapped.
  const statusByThread = useKanbanGitStatuses(threads, _statusByBranch, _threadToBranchKey);

  // Highlight the card the user came from, then fade it out
  const [highlightThreadId, setHighlightThreadId] = useState<string | undefined>(
    initialHighlightId,
  );
  useEffect(() => {
    if (!highlightThreadId) return;
    const timer = setTimeout(() => setHighlightThreadId(undefined), 3000);
    return () => clearTimeout(timer);
  }, [highlightThreadId]);

  const handleAddThread = useCallback((threadProjectId: string, stage: ThreadStage) => {
    setSlideUpProjectId(threadProjectId);
    setSlideUpStage(stage);
    setSlideUpOpen(true);
  }, []);

  const handleDeleteRequest = useCallback((thread: Thread) => {
    setDeleteConfirm({
      threadId: thread.id,
      projectId: thread.projectId,
      title: thread.title,
      isWorktree: thread.mode === 'worktree' && !!resolveThreadBranch(thread),
    });
  }, []);

  const handleArchiveRequest = useCallback(
    (thread: Thread) => {
      archiveThread(thread.id, thread.projectId);
      toast.success(t('toast.threadArchived', { title: thread.title }));
    },
    [archiveThread, t],
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirm) return;
    return whilePending(setDeleteLoading, async () => {
      const { threadId, projectId: threadProjectId, title } = deleteConfirm;
      const wasSelected = selectedThreadId === threadId;
      const deleted = await deleteThread(threadId, threadProjectId);
      setDeleteConfirm(null);
      // A refused delete already brought the card back with an error toast.
      if (!deleted) return;
      toast.success(t('toast.threadDeleted', { title }));
      if (wasSelected) navigate(buildPath(`/projects/${threadProjectId}`));
    });
  }, [deleteConfirm, selectedThreadId, deleteThread, navigate, t]);

  const handleMergeWarningConfirm = useCallback(() => {
    if (!mergeWarning) return;
    const { threadId, title, sourceStage, newStage } = mergeWarning;
    const targetProjectId = projectId || threads.find((th) => th.id === threadId)?.projectId;
    if (targetProjectId) {
      updateThreadStage(threadId, targetProjectId, newStage);
      const fromLabel = t(stageConfig[sourceStage].labelKey);
      const toLabel = t(stageConfig[newStage].labelKey);
      toast.success(t('toast.threadMoved', { title, from: fromLabel, to: toLabel }));
    }
    setMergeWarning(null);
  }, [mergeWarning, projectId, threads, updateThreadStage, t]);

  // Kanban forces idle for backlog/planning columns; in_progress runs normally.
  // Local/worktree comes from the caller's runtime row (project-runtime-settings).
  const slideUpDefaultThreadMode = useProjectThreadMode(slideUpProjectId);
  const slideUpForceIdle = slideUpStage === 'backlog' || slideUpStage === 'planning';

  const { creating, createThread: handlePromptSubmit } = useThreadCreation({
    projectId: slideUpProjectId ?? null,
    defaultThreadMode: slideUpDefaultThreadMode,
    toolPermissions,
    forceIdle: slideUpForceIdle,
    stage: slideUpStage === 'planning' ? 'planning' : undefined,
    onSuccess: async (_threadId, _kind, thread) => {
      if (slideUpProjectId) await loadThreadsForProject(slideUpProjectId);
      toast.success(t('toast.threadCreated', { title: thread?.title ?? '' }));
    },
  });

  const projectInfoById = useMemo(() => {
    const map: Record<string, { name: string; color?: string; path?: string }> = {};
    for (const p of projects) map[p.id] = { name: p.name, color: p.color, path: p.path };
    return map;
  }, [projects]);

  const threadsByStage = useMemo(() => groupThreadsByStage(threads), [threads]);

  const handleDrop = useCallback(
    ({ source, location }: { source: any; location: any }) => {
      const targets = location.current.dropTargets;
      if (!targets.length) return;
      if (source.data.type !== 'kanban-card') return;

      // The drag data is KanbanCard's getInitialData payload.
      const threadId: string = source.data.threadId;
      const sourceStage: ThreadStage = source.data.sourceStage;
      const threadProjectId: string = source.data.projectId;

      // Find the column target
      const columnTarget = targets.find((t: any) => t.data.type === 'kanban-column');
      if (!columnTarget) return;

      // The column target data is KanbanColumn's getData payload.
      const newStage: ThreadStage = columnTarget.data.stage;
      if (newStage === sourceStage) return;

      const targetProjectId = projectId || threadProjectId;

      // Check if moving to "Done" with uncommitted changes
      if (newStage === 'done') {
        const gitStatus = statusByThread[threadId];
        const thread = threads.find((t) => t.id === threadId);

        // Only warn for dirty (uncommitted) changes — unpushed commits are safe
        if (thread?.branch && gitStatus && gitStatus.state === 'dirty') {
          setMergeWarning({
            threadId,
            title: thread.title,
            sourceStage,
            newStage,
            gitState: gitStatus.state,
          });
          return;
        }
      }

      moveThreadToStage(threadId, targetProjectId, sourceStage, newStage, {
        archiveThread,
        unarchiveThread,
        updateThreadStage,
      });

      const thread = threads.find((th) => th.id === threadId);
      const title = thread?.title || threadId;
      const fromLabel = t(stageConfig[sourceStage].labelKey);
      const toLabel = t(stageConfig[newStage].labelKey);
      toast.success(t('toast.threadMoved', { title, from: fromLabel, to: toLabel }));
    },
    [projectId, updateThreadStage, archiveThread, unarchiveThread, statusByThread, threads, t],
  );

  useEffect(() => {
    return monitorForElements({ onDrop: handleDrop });
  }, [handleDrop]);

  const boardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = boardRef.current;
    if (!el) return;
    return autoScrollForElements({ element: el });
  }, []);

  return (
    <>
      <div ref={boardRef} className="flex h-full gap-3 overflow-x-auto px-4 py-2">
        {STAGES.map((stage) => (
          <KanbanColumn
            key={stage}
            stage={stage}
            threads={threadsByStage[stage]}
            projectInfoById={projectInfoById}
            onDelete={handleDeleteRequest}
            onArchive={handleArchiveRequest}
            projectId={projectId}
            projects={projects}
            onAddThread={handleAddThread}
            search={search}
            caseSensitive={caseSensitive}
            contentSnippets={contentSnippets}
            highlightThreadId={highlightThreadId}
            statusByThread={statusByThread}
          />
        ))}
      </div>

      <ConfirmDialog
        open={!!deleteConfirm}
        onOpenChange={(open) => {
          if (!open) setDeleteConfirm(null);
        }}
        title={t('dialog.deleteThread')}
        description={t('dialog.deleteThreadDesc', {
          title:
            deleteConfirm?.title && deleteConfirm.title.length > 80
              ? deleteConfirm.title.slice(0, 80) + '…'
              : deleteConfirm?.title,
        })}
        warning={deleteConfirm?.isWorktree ? t('dialog.worktreeWarning') : undefined}
        cancelLabel={t('common.cancel')}
        confirmLabel={t('common.delete')}
        loading={deleteLoading}
        onCancel={() => setDeleteConfirm(null)}
        onConfirm={handleDeleteConfirm}
      />

      <MergeWarningDialog
        mergeWarning={mergeWarning}
        onClose={() => setMergeWarning(null)}
        onConfirm={handleMergeWarningConfirm}
      />

      <SlideUpPrompt
        open={slideUpOpen}
        onClose={() => setSlideUpOpen(false)}
        onSubmit={handlePromptSubmit}
        loading={creating}
        projectId={slideUpProjectId}
      />
    </>
  );
}

function useKanbanGitStatuses(
  threads: Thread[],
  _statusByBranch: Record<string, GitStatusInfo>,
  _threadToBranchKey: Record<string, string>,
) {
  const statusByThread = useMemo(() => {
    const result: Record<string, GitStatusInfo> = {};
    for (const t of threads) {
      const bk = _threadToBranchKey[t.id] || computeBranchKey(t);
      if (_statusByBranch[bk]) result[t.id] = _statusByBranch[bk];
    }
    return result;
  }, [threads, _statusByBranch, _threadToBranchKey]);
  return statusByThread;
}

function moveThreadToStage(
  threadId: string,
  projectId: string,
  source: ThreadStage,
  target: ThreadStage,
  actions: Pick<
    ReturnType<typeof useThreadStore.getState>,
    'archiveThread' | 'unarchiveThread' | 'updateThreadStage'
  >,
) {
  if (target === 'archived') actions.archiveThread(threadId, projectId);
  else if (source === 'archived') actions.unarchiveThread(threadId, projectId, target);
  else actions.updateThreadStage(threadId, projectId, target);
}

function MergeWarningDialog({
  mergeWarning,
  onClose,
  onConfirm,
}: {
  mergeWarning: { gitState: string; title: string } | null;
  onClose: () => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ConfirmDialog
      open={!!mergeWarning}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={t(`dialog.${mergeWarningKey(mergeWarning?.gitState)}`)}
      description={t(`dialog.${mergeWarningKey(mergeWarning?.gitState)}Desc`, {
        title: shortenWarningTitle(mergeWarning?.title),
      })}
      variant="default"
      cancelLabel={t('common.cancel')}
      confirmLabel={t('common.continue')}
      onCancel={() => onClose()}
      onConfirm={onConfirm}
    />
  );
}

function mergeWarningKey(state: string | undefined) {
  if (state === 'unpushed') return 'unpushedChanges';
  if (state === 'dirty') return 'dirtyChanges';
  return 'unmergedChanges';
}
function shortenWarningTitle(title: string | undefined) {
  return title && title.length > 80 ? title.slice(0, 80) + '…' : title;
}
