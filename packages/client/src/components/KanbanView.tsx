import { useState, useEffect, useRef, useMemo, useCallback, startTransition } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import { GitBranch, Pin, Plus, Search, Trash2, Chrome, Bot, Webhook, Terminal } from 'lucide-react';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { Thread, ThreadStage, Project, ThreadSource } from '@funny/shared';
import { HighlightText, normalize } from '@/components/ui/highlight-text';
import { useAppStore } from '@/stores/app-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';
import { useGitStatusStore } from '@/stores/git-status-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { stageConfig, statusConfig, gitSyncStateConfig, timeAgo } from '@/lib/thread-utils';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { cn } from '@/lib/utils';
import { api } from '@/lib/api';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { SlideUpPrompt } from '@/components/SlideUpPrompt';

interface KanbanViewProps {
  threads: Thread[];
  projectId?: string;
  search?: string;
  contentSnippets?: Map<string, string>;
  highlightThreadId?: string;
}

const STAGES: ThreadStage[] = ['backlog', 'in_progress', 'review', 'done', 'archived'];

const SOURCE_ICON: Record<string, typeof Chrome | undefined> = {
  chrome_extension: Chrome,
  api: Terminal,
  automation: Bot,
  ingest: Webhook,
};

function KanbanCard({ thread, projectInfo, onDelete, search, ghost, contentSnippet, projectId, highlighted, stage }: { thread: Thread; projectInfo?: { name: string; color?: string }; onDelete: (thread: Thread) => void; search?: string; ghost?: boolean; contentSnippet?: string; projectId?: string; highlighted?: boolean; stage: ThreadStage }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const statusByThread = useGitStatusStore((s) => s.statusByThread);
  const setKanbanContext = useUIStore((s) => s.setKanbanContext);
  const pinThread = useThreadStore((s) => s.pinThread);
  const ref = useRef<HTMLDivElement>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Scroll the highlighted card into view when returning from thread view
  useEffect(() => {
    if (highlighted && ref.current) {
      ref.current.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
  }, [highlighted]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    return draggable({
      element: el,
      getInitialData: () => ({
        type: 'kanban-card',
        threadId: thread.id,
        sourceStage: thread.archived ? 'archived' : (thread.stage || 'backlog'),
        projectId: thread.projectId,
      }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });
  }, [thread.id, thread.stage, thread.archived, thread.projectId]);


  const StatusIcon = statusConfig[thread.status].icon;
  const statusClassName = statusConfig[thread.status].className;

  const gitStatus = statusByThread[thread.id];
  const gitConf = gitStatus ? gitSyncStateConfig[gitStatus.state] : null;
  const GitIcon = gitConf?.icon;
  const displayBranch = thread.branch || thread.baseBranch;

  return (
    <div
      ref={ref}
      className={cn(
        'group/card relative rounded-md border bg-card p-2.5 cursor-pointer transition-all duration-500',
        isDragging && 'opacity-40',
        ghost && !isDragging && 'opacity-50 hover:opacity-80',
        highlighted && 'ring-2 ring-ring shadow-md'
      )}
      onClick={() => {
        if (!isDragging) {
          startTransition(() => {
            setKanbanContext({ projectId, search, threadId: thread.id });
            navigate(`/projects/${thread.projectId}/threads/${thread.id}`);
          });
        }
      }}
    >
      <div className="absolute top-1.5 right-1.5 flex items-center gap-0.5">
        {thread.pinned && stage === 'review' ? (
          <button
            className="p-1 rounded transition-opacity hover:bg-primary/10 text-primary"
            onClick={async (e) => {
              e.stopPropagation();
              await pinThread(thread.id, thread.projectId, false);
            }}
            aria-label="Unpin thread"
          >
            <Pin className="h-3 w-3 rotate-45" />
          </button>
        ) : null}
        <button
          className="p-1 rounded opacity-0 group-hover/card:opacity-100 transition-opacity hover:bg-destructive/10 hover:text-destructive text-muted-foreground"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(thread);
          }}
          aria-label="Delete thread"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {projectInfo && (
        <span
          className="text-xs px-1.5 py-0.5 rounded inline-block mb-1"
          style={{
            backgroundColor: projectInfo.color ? `${projectInfo.color}1A` : '#3b82f61A',
            color: projectInfo.color || '#3b82f6',
          }}
        >
          {projectInfo.name}
        </span>
      )}

      {displayBranch && (
        <div className="flex items-center gap-1 mb-1.5 min-w-0" aria-label="Branch information">
          {gitConf && GitIcon ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <GitIcon className={cn('h-3 w-3 shrink-0', gitConf.className)} />
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {t(gitConf.labelKey)}
              </TooltipContent>
            </Tooltip>
          ) : (
            <GitBranch className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <span className="text-xs text-muted-foreground truncate" title={displayBranch}>
            {displayBranch}
          </span>
        </div>
      )}

      <HighlightText text={thread.title} query={search || ''} className="text-xs font-medium mb-1 line-clamp-3 pr-5" />
      {contentSnippet && search && !normalize(thread.title).includes(normalize(search)) && (
        <HighlightText
          text={contentSnippet}
          query={search}
          className="text-[11px] text-muted-foreground mb-1.5 line-clamp-2 block italic"
        />
      )}

      <div className="flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1 min-w-0">
          <StatusIcon className={cn('h-3 w-3 shrink-0', statusClassName)} />
          <span className="text-xs text-muted-foreground truncate">
            {t(`thread.status.${thread.status}`)}
          </span>
          {thread.source && thread.source !== 'web' && SOURCE_ICON[thread.source] && (() => {
            const SourceIcon = SOURCE_ICON[thread.source]!;
            return (
              <Tooltip>
                <TooltipTrigger asChild>
                  <SourceIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
                </TooltipTrigger>
                <TooltipContent side="top" className="text-xs">
                  {t(`thread.source.${thread.source}`)}
                </TooltipContent>
              </Tooltip>
            );
          })()}
        </div>
        <div className="flex items-center gap-2 shrink-0 text-xs text-muted-foreground">
          <span>{timeAgo(thread.completedAt || thread.createdAt, t)}</span>
          {thread.cost > 0 && <span>${thread.cost.toFixed(3)}</span>}
        </div>
      </div>
    </div>
  );
}

function AddThreadButton({ projectId, projects, onSelect }: { projectId?: string; projects: Project[]; onSelect: (projectId: string) => void; }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Single project mode: click goes straight to new thread
  if (projectId) {
    return (
      <button
        className="ml-auto p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        onClick={() => onSelect(projectId)}
        title={t('kanban.addThread')}
      >
        <Plus className="h-4 w-4" />
      </button>
    );
  }

  const filtered = search
    ? projects.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    : projects;

  return (
    <Popover open={open} onOpenChange={(v) => { setOpen(v); if (!v) setSearch(''); }}>
      <PopoverTrigger asChild>
        <button
          className="ml-auto p-0.5 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
          title={t('kanban.addThread')}
        >
          <Plus className="h-4 w-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-56 p-0">
        <div className="flex items-center gap-2 px-2.5 py-2 border-b border-border/50">
          <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <Input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('kanban.searchProject')}
            className="flex-1 h-auto border-0 bg-transparent text-xs shadow-none focus-visible:ring-0 px-0 py-0 placeholder:text-muted-foreground"
            autoFocus
          />
        </div>
        <div className="max-h-48 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-3">
              {t('commandPalette.noResults')}
            </div>
          ) : (
            filtered.map((p) => (
              <button
                key={p.id}
                className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-accent transition-colors flex items-center gap-2"
                onClick={() => {
                  setOpen(false);
                  setSearch('');
                  onSelect(p.id);
                }}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: p.color || '#3b82f6' }}
                />
                <span className="truncate">{p.name}</span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function KanbanColumn({ stage, threads, projectInfoById, onDelete, projectId, projects, onAddThread, search, contentSnippets, highlightThreadId }: { stage: ThreadStage; threads: Thread[]; projectInfoById?: Record<string, { name: string; color?: string }>; onDelete: (thread: Thread) => void; projectId?: string; projects: Project[]; onAddThread: (projectId: string, stage: ThreadStage) => void; search?: string; contentSnippets?: Map<string, string>; highlightThreadId?: string }) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const [isDraggedOver, setIsDraggedOver] = useState(false);
  const [visibleCount, setVisibleCount] = useState(20);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    return dropTargetForElements({
      element: el,
      getData: () => ({ type: 'kanban-column', stage }),
      canDrop: ({ source }) => source.data.type === 'kanban-card',
      onDragEnter: () => setIsDraggedOver(true),
      onDragLeave: () => setIsDraggedOver(false),
      onDrop: () => setIsDraggedOver(false),
    });
  }, [stage]);

  // Reset visible count only when search/filter changes, not when a card is moved
  useEffect(() => {
    setVisibleCount(20);
  }, [search, projectId]);

  // If the highlighted thread is beyond the visible count, expand to include it
  useEffect(() => {
    if (!highlightThreadId) return;
    const idx = threads.findIndex((t) => t.id === highlightThreadId);
    if (idx >= visibleCount) {
      setVisibleCount(idx + 1);
    }
  }, [highlightThreadId, threads, visibleCount]);

  const StageIcon = stageConfig[stage].icon;
  const stageClassName = stageConfig[stage].className;

  const visibleThreads = threads.slice(0, visibleCount);
  const hasMore = threads.length > visibleCount;

  return (
    <div
      ref={ref}
      className={cn(
        'flex flex-col w-80 min-w-[20rem] flex-shrink-0 rounded-lg bg-secondary/30 transition-colors',
        isDraggedOver && 'ring-2 ring-ring bg-secondary/50'
      )}
    >
      <div className="px-3 py-2.5 border-b border-border/50 flex items-center gap-2">
        <StageIcon className={cn('h-4 w-4', stageClassName)} />
        <span className="font-medium text-sm">{t(stageConfig[stage].labelKey)}</span>
        <span className="text-xs text-muted-foreground">({threads.length})</span>
        {projects.length > 0 && stage !== 'review' && stage !== 'done' && stage !== 'archived' && (
          <AddThreadButton projectId={projectId} projects={projects} onSelect={(pid) => onAddThread(pid, stage)} />
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[200px]">
        {threads.length === 0 ? (
          <div className="text-center text-xs text-muted-foreground py-8">
            {t('kanban.emptyColumn')}
          </div>
        ) : (
          <>
            {visibleThreads.map((thread) => <KanbanCard key={thread.id} thread={thread} projectInfo={projectInfoById?.[thread.projectId]} onDelete={onDelete} search={search} ghost={stage === 'archived'} contentSnippet={contentSnippets?.get(thread.id)} projectId={projectId} highlighted={thread.id === highlightThreadId} stage={stage} />)}
            {hasMore && (
              <button
                onClick={() => setVisibleCount((prev) => prev + 20)}
                className="w-full py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-accent rounded-md transition-colors"
              >
                {t('kanban.loadMore', { count: Math.min(20, threads.length - visibleCount) })}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function KanbanView({ threads, projectId, search, contentSnippets, highlightThreadId: initialHighlightId }: KanbanViewProps) {
  const { t } = useTranslation();
  useMinuteTick();
  const navigate = useNavigate();
  const updateThreadStage = useThreadStore((s) => s.updateThreadStage);
  const archiveThread = useThreadStore((s) => s.archiveThread);
  const unarchiveThread = useThreadStore((s) => s.unarchiveThread);
  const deleteThread = useThreadStore((s) => s.deleteThread);
  const pinThread = useThreadStore((s) => s.pinThread);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const projects = useAppStore((s) => s.projects);
  const loadThreadsForProject = useAppStore((s) => s.loadThreadsForProject);
  const defaultThreadMode = useSettingsStore((s) => s.defaultThreadMode);
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
  const [creating, setCreating] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [mergeWarning, setMergeWarning] = useState<{
    threadId: string;
    title: string;
    newStage: ThreadStage;
    gitState: string;
  } | null>(null);
  const statusByThread = useGitStatusStore((s) => s.statusByThread);

  // Highlight the card the user came from, then fade it out
  const [highlightThreadId, setHighlightThreadId] = useState<string | undefined>(initialHighlightId);
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
      isWorktree: thread.mode === 'worktree' && !!thread.branch,
    });
  }, []);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteConfirm) return;
    setDeleteLoading(true);
    const { threadId, projectId: threadProjectId, title } = deleteConfirm;
    const wasSelected = selectedThreadId === threadId;
    await deleteThread(threadId, threadProjectId);
    setDeleteLoading(false);
    setDeleteConfirm(null);
    toast.success(t('toast.threadDeleted', { title }));
    if (wasSelected) navigate(`/projects/${threadProjectId}`);
  }, [deleteConfirm, selectedThreadId, deleteThread, navigate, t]);

  const handleMergeWarningConfirm = useCallback(() => {
    if (!mergeWarning) return;
    const { threadId, newStage } = mergeWarning;
    const targetProjectId = projectId || threads.find((t) => t.id === threadId)?.projectId;
    if (targetProjectId) {
      updateThreadStage(threadId, targetProjectId, newStage);
    }
    setMergeWarning(null);
  }, [mergeWarning, projectId, threads, updateThreadStage]);

  const handlePromptSubmit = useCallback(async (
    prompt: string,
    opts: { model: string; mode: string; threadMode?: string; baseBranch?: string; sendToBacklog?: boolean },
    images?: any[]
  ): Promise<boolean> => {
    if (!slideUpProjectId || creating) return false;
    setCreating(true);

    const threadMode = (opts.threadMode as 'local' | 'worktree') || defaultThreadMode;
    const toBacklog = opts.sendToBacklog || slideUpStage === 'backlog';

    if (toBacklog) {
      // Create idle thread (backlog)
      const result = await api.createIdleThread({
        projectId: slideUpProjectId,
        title: prompt.slice(0, 200),
        mode: threadMode,
        baseBranch: opts.baseBranch,
        prompt,
      });

      if (result.isErr()) {
        toast.error(result.error.message);
        setCreating(false);
        return false;
      }

      await loadThreadsForProject(slideUpProjectId);
      setCreating(false);
      toast.success(t('toast.threadCreated', { title: prompt.slice(0, 200) }));
      return true;
    } else {
      // Create and execute thread (in_progress)
      const { allowedTools, disallowedTools } = deriveToolLists(toolPermissions);
      const result = await api.createThread({
        projectId: slideUpProjectId,
        title: prompt.slice(0, 200),
        mode: threadMode,
        model: opts.model,
        permissionMode: opts.mode,
        baseBranch: opts.baseBranch,
        prompt,
        images,
        allowedTools,
        disallowedTools,
      });

      if (result.isErr()) {
        toast.error(result.error.message);
        setCreating(false);
        return false;
      }

      await loadThreadsForProject(slideUpProjectId);
      setCreating(false);
      toast.success(t('toast.threadCreated', { title: prompt.slice(0, 200) }));
      return true;
    }
  }, [slideUpProjectId, slideUpStage, creating, defaultThreadMode, toolPermissions, loadThreadsForProject, t]);

  const projectInfoById = useMemo(() => {
    if (projectId) return undefined;
    const map: Record<string, { name: string; color?: string }> = {};
    for (const p of projects) map[p.id] = { name: p.name, color: p.color };
    return map;
  }, [projectId, projects]);

  const threadsByStage = useMemo(() => {
    const map: Record<ThreadStage, Thread[]> = {
      backlog: [],
      in_progress: [],
      review: [],
      done: [],
      archived: [],
    };

    for (const thread of threads) {
      const stage = thread.archived ? 'archived' : (thread.stage || 'backlog');
      if (map[stage]) {
        map[stage].push(thread);
      }
    }

    // Sort each column: pinned first only in review, then by date (most recent first)
    for (const stage of STAGES) {
      map[stage].sort((a, b) => {
        if (stage === 'review' && a.pinned !== b.pinned) return a.pinned ? -1 : 1;
        const dateA = a.completedAt || a.createdAt;
        const dateB = b.completedAt || b.createdAt;
        return new Date(dateB).getTime() - new Date(dateA).getTime();
      });
    }

    return map;
  }, [threads]);

  const handleDrop = useCallback(
    ({ source, location }: { source: any; location: any }) => {
      const targets = location.current.dropTargets;
      if (!targets.length) return;
      if (source.data.type !== 'kanban-card') return;

      const threadId = source.data.threadId as string;
      const sourceStage = source.data.sourceStage as ThreadStage;
      const threadProjectId = source.data.projectId as string;

      // Find the column target
      const columnTarget = targets.find(
        (t: any) => t.data.type === 'kanban-column'
      );
      if (!columnTarget) return;

      const newStage = columnTarget.data.stage as ThreadStage;
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
            newStage,
            gitState: gitStatus.state,
          });
          return;
        }
      }

      // Auto-unpin when moving out of review
      if (sourceStage === 'review' && newStage !== 'review') {
        const thread = threads.find((t) => t.id === threadId);
        if (thread?.pinned) {
          pinThread(threadId, targetProjectId, false);
        }
      }

      if (newStage === 'archived') {
        // Dragging to archived column → archive the thread
        archiveThread(threadId, targetProjectId);
      } else if (sourceStage === 'archived') {
        // Dragging from archived column → unarchive and set new stage
        unarchiveThread(threadId, targetProjectId, newStage);
      } else {
        updateThreadStage(threadId, targetProjectId, newStage);
      }
    },
    [projectId, updateThreadStage, archiveThread, unarchiveThread, pinThread, statusByThread, threads]
  );

  useEffect(() => {
    return monitorForElements({ onDrop: handleDrop });
  }, [handleDrop]);

  return (
    <>
      <div className="flex gap-3 h-full overflow-x-auto p-4">
        {STAGES.map((stage) => (
          <KanbanColumn key={stage} stage={stage} threads={threadsByStage[stage]} projectInfoById={projectInfoById} onDelete={handleDeleteRequest} projectId={projectId} projects={projects} onAddThread={handleAddThread} search={search} contentSnippets={contentSnippets} highlightThreadId={highlightThreadId} />
        ))}
      </div>

      <Dialog
        open={!!deleteConfirm}
        onOpenChange={(open) => { if (!open) setDeleteConfirm(null); }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('dialog.deleteThread')}</DialogTitle>
            <DialogDescription className="break-all">
              {t('dialog.deleteThreadDesc', { title: deleteConfirm?.title && deleteConfirm.title.length > 80 ? deleteConfirm.title.slice(0, 80) + '…' : deleteConfirm?.title })}
            </DialogDescription>
          </DialogHeader>
          {deleteConfirm?.isWorktree && (
            <p className="text-xs text-status-warning/80 bg-status-warning/10 rounded-md px-3 py-2">
              {t('dialog.worktreeWarning')}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setDeleteConfirm(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleDeleteConfirm} loading={deleteLoading}>
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!mergeWarning}
        onOpenChange={(open) => { if (!open) setMergeWarning(null); }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{t(`dialog.${mergeWarning?.gitState === 'unpushed' ? 'unpushedChanges' : mergeWarning?.gitState === 'dirty' ? 'dirtyChanges' : 'unmergedChanges'}`)}</DialogTitle>
            <DialogDescription className="break-all">
              {t(`dialog.${mergeWarning?.gitState === 'unpushed' ? 'unpushedChangesDesc' : mergeWarning?.gitState === 'dirty' ? 'dirtyChangesDesc' : 'unmergedChangesDesc'}`, { title: mergeWarning?.title && mergeWarning.title.length > 80 ? mergeWarning.title.slice(0, 80) + '…' : mergeWarning?.title })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setMergeWarning(null)}>
              {t('common.cancel')}
            </Button>
            <Button variant="default" size="sm" onClick={handleMergeWarningConfirm}>
              {t('common.continue')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
