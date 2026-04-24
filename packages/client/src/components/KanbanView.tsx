import { autoScrollForElements } from '@atlaskit/pragmatic-drag-and-drop-auto-scroll/element';
import {
  draggable,
  dropTargetForElements,
  monitorForElements,
} from '@atlaskit/pragmatic-drag-and-drop/element/adapter';
import type { Thread, ThreadStage, Project, GitStatusInfo } from '@funny/shared';
import { DEFAULT_THREAD_MODE } from '@funny/shared/models';
import {
  Pin,
  PinOff,
  Plus,
  Search,
  Trash2,
  Chrome,
  Bot,
  Webhook,
  Terminal,
  FolderOpenDot,
  MoreVertical,
  Square,
  Archive,
} from 'lucide-react';
import { useState, useEffect, useRef, useMemo, useCallback, memo, startTransition } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { ConfirmDialog } from '@/components/ConfirmDialog';
import { SlideUpPrompt } from '@/components/SlideUpPrompt';
import { ThreadPowerline } from '@/components/ThreadPowerline';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { HighlightText, normalize } from '@/components/ui/highlight-text';
import { Input } from '@/components/ui/input';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import { colorFromName } from '@/components/ui/project-chip';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { stageConfig, statusConfig, timeAgo } from '@/lib/thread-utils';
import { toastError } from '@/lib/toast-error';
import { buildPath } from '@/lib/url';
import { cn, resolveThreadBranch } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';
import { useGitStatusStore, branchKey as computeBranchKey } from '@/stores/git-status-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

interface KanbanViewProps {
  threads: Thread[];
  projectId?: string;
  search?: string;
  contentSnippets?: Map<string, string>;
  highlightThreadId?: string;
}

const STAGES: ThreadStage[] = ['backlog', 'planning', 'in_progress', 'review', 'done', 'archived'];

const SOURCE_ICON: Record<string, typeof Chrome | undefined> = {
  chrome_extension: Chrome,
  api: Terminal,
  automation: Bot,
  ingest: Webhook,
};

const AUTOMATED_SOURCES = new Set(['automation', 'pipeline', 'external']);

export const KanbanCard = memo(function KanbanCard({
  thread,
  projectInfo,
  onDelete,
  onArchive,
  search,
  ghost,
  contentSnippet,
  projectId,
  highlighted,
  stage: _stage,
  gitStatus: gitStatusProp,
}: {
  thread: Thread;
  projectInfo?: { name: string; color?: string; path?: string };
  onDelete: (thread: Thread) => void;
  onArchive?: (thread: Thread) => void;
  search?: string;
  ghost?: boolean;
  contentSnippet?: string;
  projectId?: string;
  highlighted?: boolean;
  stage: ThreadStage;
  gitStatus?: GitStatusInfo;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
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
        sourceStage: thread.archived ? 'archived' : thread.stage || 'backlog',
        projectId: thread.projectId,
      }),
      onDragStart: () => setIsDragging(true),
      onDrop: () => setIsDragging(false),
    });
  }, [thread.id, thread.stage, thread.archived, thread.projectId]);

  const StatusIcon = statusConfig[thread.status].icon;
  const statusClassName = statusConfig[thread.status].className;
  const isRunning = thread.status === 'running';
  const isBusy = isRunning || thread.status === 'setting_up';

  const [openDropdown, setOpenDropdown] = useState(false);
  const handleDropdownChange = useCallback((open: boolean) => setOpenDropdown(open), []);

  return (
    <div
      ref={ref}
      data-testid={`kanban-card-${thread.id}`}
      className={cn(
        'group/card flex items-stretch rounded-md border bg-card cursor-pointer transition-[opacity,box-shadow] duration-300',
        isDragging && 'opacity-40',
        ghost && !isDragging && 'opacity-50 hover:opacity-80',
        highlighted && 'ring-2 ring-ring shadow-md',
      )}
      onClick={() => {
        if (!isDragging) {
          startTransition(() => {
            setKanbanContext({ projectId, search, threadId: thread.id });
            navigate(buildPath(`/projects/${thread.projectId}/threads/${thread.id}`));
          });
        }
      }}
    >
      {/* Left: main content */}
      <div className="min-w-0 flex-1 px-3.5 py-3">
        <div className="mb-2 flex min-w-0 items-start gap-2">
          <div className="relative mt-0.5 h-3.5 w-3.5 shrink-0">
            {thread.pinned && !isBusy ? (
              <span
                className={cn(
                  'absolute inset-0 flex items-center justify-center text-muted-foreground',
                  'group-hover/card:hidden',
                )}
              >
                <Pin className="icon-sm" />
              </span>
            ) : (
              <span className={cn('absolute inset-0', 'group-hover/card:hidden')}>
                <StatusIcon className={cn('icon-sm', statusClassName)} />
              </span>
            )}
            <span
              className="absolute inset-0 hidden cursor-pointer items-center justify-center text-muted-foreground hover:text-foreground group-hover/card:flex"
              onClick={(e) => {
                e.stopPropagation();
                pinThread(thread.id, thread.projectId, !thread.pinned);
              }}
            >
              {thread.pinned ? <PinOff className="icon-sm" /> : <Pin className="icon-sm" />}
            </span>
          </div>
          <HighlightText
            text={thread.title}
            query={search || ''}
            className="line-clamp-6 text-sm font-medium leading-relaxed text-muted-foreground transition-colors group-hover/card:text-foreground"
          />
        </div>

        <ThreadPowerline
          thread={thread}
          projectName={projectInfo?.name}
          projectColor={projectInfo?.color}
          gitStatus={gitStatusProp}
          diffStatsSize="xxs"
          className="mb-2"
          data-testid={`kanban-card-powerline-${thread.id}`}
        />

        {contentSnippet && search && !normalize(thread.title).includes(normalize(search)) && (
          <HighlightText
            text={contentSnippet}
            query={search}
            className="mb-1 line-clamp-2 block text-[11px] italic text-muted-foreground"
          />
        )}
      </div>

      {/* Right: time / more menu overlay */}
      <div className="flex shrink-0 items-center px-1.5">
        <div className="grid min-w-[2.5rem] place-items-center justify-items-center">
          <span
            className={cn(
              'col-start-1 row-start-1 text-xs text-muted-foreground leading-4 h-4 group-hover/card:opacity-0 group-hover/card:pointer-events-none',
              openDropdown && 'opacity-0 pointer-events-none',
            )}
          >
            {timeAgo(thread.completedAt || thread.createdAt, t)}
          </span>
          <div
            className={cn(
              'col-start-1 row-start-1 flex items-center opacity-0 group-hover/card:opacity-100',
              openDropdown && '!opacity-100',
            )}
          >
            <DropdownMenu onOpenChange={handleDropdownChange}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  tabIndex={-1}
                  data-testid={`kanban-card-more-${thread.id}`}
                  onClick={(e) => e.stopPropagation()}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <MoreVertical className="icon-sm" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" side="bottom">
                <DropdownMenuItem
                  onClick={async (e) => {
                    e.stopPropagation();
                    const folderPath = thread.worktreePath || projectInfo?.path;
                    if (!folderPath) return;
                    const result = await api.openDirectory(folderPath);
                    if (result.isErr()) {
                      toastError(result.error);
                    }
                  }}
                >
                  <FolderOpenDot className="icon-sm" />
                  {t('sidebar.openDirectory')}
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={async (e) => {
                    e.stopPropagation();
                    const folderPath = thread.worktreePath || projectInfo?.path;
                    if (!folderPath) return;
                    const result = await api.openTerminal(folderPath);
                    if (result.isErr()) {
                      toastError(result.error);
                    }
                  }}
                >
                  <Terminal className="icon-sm" />
                  {t('sidebar.openTerminal')}
                </DropdownMenuItem>
                {isRunning && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      onClick={async (e) => {
                        e.stopPropagation();
                        const result = await api.stopThread(thread.id);
                        if (result.isErr()) {
                          console.error('Failed to stop thread:', result.error);
                        }
                      }}
                      className="text-status-error focus:text-status-error"
                    >
                      <Square className="icon-sm" />
                      {t('common.stop')}
                    </DropdownMenuItem>
                  </>
                )}
                {onArchive && !isBusy && (
                  <DropdownMenuItem
                    onClick={(e) => {
                      e.stopPropagation();
                      onArchive(thread);
                    }}
                  >
                    <Archive className="icon-sm" />
                    {t('sidebar.archive')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  data-testid={`kanban-card-delete-${thread.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(thread);
                  }}
                  className="text-status-error focus:text-status-error"
                >
                  <Trash2 className="icon-sm" />
                  {t('common.delete')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>
    </div>
  );
});

function AddThreadButton({
  projectId,
  projects,
  onSelect,
}: {
  projectId?: string;
  projects: Project[];
  onSelect: (projectId: string) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Single project mode: click goes straight to new thread
  if (projectId) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            data-testid="kanban-add-thread"
            className="ml-auto rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => onSelect(projectId)}
            aria-label={t('kanban.addThread')}
          >
            <Plus className="icon-base" />
          </button>
        </TooltipTrigger>
        <TooltipContent>{t('kanban.addThread')}</TooltipContent>
      </Tooltip>
    );
  }

  const filtered = search
    ? projects.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
    : projects;

  return (
    <Popover
      open={open}
      onOpenChange={(v) => {
        setOpen(v);
        if (!v) setSearch('');
      }}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <button
              data-testid="kanban-add-thread"
              className="ml-auto rounded p-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              aria-label={t('kanban.addThread')}
            >
              <Plus className="icon-base" />
            </button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t('kanban.addThread')}</TooltipContent>
      </Tooltip>
      <PopoverContent align="start" className="w-64 p-0">
        <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2.5">
          <Search className="icon-base shrink-0 text-muted-foreground" />
          <Input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('kanban.searchProject')}
            className="h-auto flex-1 rounded-none border-0 bg-transparent px-0 py-0 text-sm shadow-none placeholder:text-muted-foreground focus-visible:ring-0"
            autoFocus
          />
        </div>
        <div className="max-h-56 overflow-y-auto py-1">
          {filtered.length === 0 ? (
            <div className="py-3 text-center text-sm text-muted-foreground">
              {t('commandPalette.noResults')}
            </div>
          ) : (
            filtered.map((p) => (
              <button
                key={p.id}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                onClick={() => {
                  setOpen(false);
                  setSearch('');
                  onSelect(p.id);
                }}
              >
                <span
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: p.color || colorFromName(p.name) }}
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

const KanbanColumn = memo(function KanbanColumn({
  stage,
  threads,
  projectInfoById,
  onDelete,
  onArchive,
  projectId,
  projects,
  onAddThread,
  search,
  contentSnippets,
  highlightThreadId,
  statusByThread,
}: {
  stage: ThreadStage;
  threads: Thread[];
  projectInfoById?: Record<string, { name: string; color?: string; path?: string }>;
  onDelete: (thread: Thread) => void;
  onArchive: (thread: Thread) => void;
  projectId?: string;
  projects: Project[];
  onAddThread: (projectId: string, stage: ThreadStage) => void;
  search?: string;
  contentSnippets?: Map<string, string>;
  highlightThreadId?: string;
  statusByThread: Record<string, GitStatusInfo>;
}) {
  const { t } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
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

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    return autoScrollForElements({ element: el });
  }, []);

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

  const visibleThreads = threads.slice(0, visibleCount);
  const hasMore = threads.length > visibleCount;

  return (
    <div
      ref={ref}
      className={cn(
        'flex flex-col w-[23rem] min-w-[23rem] flex-shrink-0 rounded-lg bg-secondary/30 transition-colors',
        isDraggedOver && 'ring-2 ring-ring bg-secondary/50',
      )}
    >
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2.5">
        <span className="text-sm font-medium">{t(stageConfig[stage].labelKey)}</span>
        <span className="text-xs text-muted-foreground">({threads.length})</span>
        {projects.length > 0 && stage !== 'review' && stage !== 'done' && stage !== 'archived' && (
          <AddThreadButton
            projectId={projectId}
            projects={projects}
            onSelect={(pid) => onAddThread(pid, stage)}
          />
        )}
      </div>

      <div ref={scrollRef} className="min-h-[200px] flex-1 space-y-2 overflow-y-auto p-2">
        {threads.length === 0 ? (
          <div className="py-8 text-center text-xs text-muted-foreground">
            {t('kanban.emptyColumn')}
          </div>
        ) : (
          <>
            {visibleThreads.map((thread) => (
              <KanbanCard
                key={thread.id}
                thread={thread}
                projectInfo={projectInfoById?.[thread.projectId]}
                onDelete={onDelete}
                onArchive={stage !== 'archived' ? onArchive : undefined}
                search={search}
                ghost={stage === 'archived'}
                contentSnippet={contentSnippets?.get(thread.id)}
                projectId={projectId}
                highlighted={thread.id === highlightThreadId}
                stage={stage}
                gitStatus={statusByThread[thread.id]}
              />
            ))}
            {hasMore && (
              <button
                data-testid={`kanban-load-more-${stage}`}
                onClick={() => setVisibleCount((prev) => prev + 20)}
                className="w-full rounded-md py-2 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                {t('kanban.loadMore', { count: Math.min(20, threads.length - visibleCount) })}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
});

export function KanbanView({
  threads,
  projectId,
  search,
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
  const projects = useAppStore((s) => s.projects);
  const loadThreadsForProject = useAppStore((s) => s.loadThreadsForProject);
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
    sourceStage: ThreadStage;
    newStage: ThreadStage;
    gitState: string;
  } | null>(null);
  const _statusByBranch = useGitStatusStore((s) => s.statusByBranch);
  const _threadToBranchKey = useGitStatusStore((s) => s.threadToBranchKey);
  // Resolve branch-keyed statuses to a threadId-keyed map for child components.
  // Prefer server-provided threadToBranchKey mapping (stable across thread data
  // refreshes) and fall back to client-side computation for threads not yet mapped.
  const statusByThread = useMemo(() => {
    const result: Record<string, GitStatusInfo> = {};
    for (const t of threads) {
      const bk = _threadToBranchKey[t.id] || computeBranchKey(t);
      if (_statusByBranch[bk]) result[t.id] = _statusByBranch[bk];
    }
    return result;
  }, [threads, _statusByBranch, _threadToBranchKey]);

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
    setDeleteLoading(true);
    const { threadId, projectId: threadProjectId, title } = deleteConfirm;
    const wasSelected = selectedThreadId === threadId;
    await deleteThread(threadId, threadProjectId);
    setDeleteLoading(false);
    setDeleteConfirm(null);
    toast.success(t('toast.threadDeleted', { title }));
    if (wasSelected) navigate(buildPath(`/projects/${threadProjectId}`));
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

  const handlePromptSubmit = useCallback(
    async (
      prompt: string,
      opts: {
        model: string;
        mode: string;
        threadMode?: string;
        baseBranch?: string;
        sendToBacklog?: boolean;
      },
      images?: any[],
    ): Promise<boolean> => {
      if (!slideUpProjectId || creating) return false;
      setCreating(true);

      const slideUpProject = projects.find((p) => p.id === slideUpProjectId);
      const threadMode =
        (opts.threadMode as 'local' | 'worktree') ||
        slideUpProject?.defaultMode ||
        DEFAULT_THREAD_MODE;
      const toIdle =
        opts.sendToBacklog || slideUpStage === 'backlog' || slideUpStage === 'planning';

      if (toIdle) {
        // Create idle thread (backlog or planning)
        const result = await api.createIdleThread({
          projectId: slideUpProjectId,
          title: prompt.slice(0, 200),
          mode: threadMode,
          baseBranch: opts.baseBranch,
          prompt,
          stage: slideUpStage === 'planning' ? 'planning' : undefined,
          images,
        });

        if (result.isErr()) {
          toastError(result.error);
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
          toastError(result.error);
          setCreating(false);
          return false;
        }

        await loadThreadsForProject(slideUpProjectId);
        setCreating(false);
        toast.success(t('toast.threadCreated', { title: prompt.slice(0, 200) }));
        return true;
      }
    },
    [slideUpProjectId, slideUpStage, creating, projects, toolPermissions, loadThreadsForProject, t],
  );

  const projectInfoById = useMemo(() => {
    const map: Record<string, { name: string; color?: string; path?: string }> = {};
    for (const p of projects) map[p.id] = { name: p.name, color: p.color, path: p.path };
    return map;
  }, [projects]);

  const threadsByStage = useMemo(() => {
    const map: Record<ThreadStage, Thread[]> = {
      backlog: [],
      planning: [],
      in_progress: [],
      review: [],
      done: [],
      archived: [],
    };

    for (const thread of threads) {
      const stage = thread.archived ? 'archived' : thread.stage || 'backlog';
      if (map[stage]) {
        map[stage].push(thread);
      }
    }

    // Sort each column: pinned first, then by date (most recent first)
    for (const stage of STAGES) {
      map[stage].sort((a, b) => {
        if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
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
      const columnTarget = targets.find((t: any) => t.data.type === 'kanban-column');
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
            sourceStage,
            newStage,
            gitState: gitStatus.state,
          });
          return;
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

      <ConfirmDialog
        open={!!mergeWarning}
        onOpenChange={(open) => {
          if (!open) setMergeWarning(null);
        }}
        title={t(
          `dialog.${mergeWarning?.gitState === 'unpushed' ? 'unpushedChanges' : mergeWarning?.gitState === 'dirty' ? 'dirtyChanges' : 'unmergedChanges'}`,
        )}
        description={t(
          `dialog.${mergeWarning?.gitState === 'unpushed' ? 'unpushedChangesDesc' : mergeWarning?.gitState === 'dirty' ? 'dirtyChangesDesc' : 'unmergedChangesDesc'}`,
          {
            title:
              mergeWarning?.title && mergeWarning.title.length > 80
                ? mergeWarning.title.slice(0, 80) + '…'
                : mergeWarning?.title,
          },
        )}
        variant="default"
        cancelLabel={t('common.cancel')}
        confirmLabel={t('common.continue')}
        onCancel={() => setMergeWarning(null)}
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
