import { DEFAULT_THREAD_MODE } from '@funny/shared/models';
import { Loader2, LayoutGrid, Grid2x2, Plus, Search, FolderOpen, X, GitBranch } from 'lucide-react';
import { useState, useEffect, useRef, useCallback, useMemo, memo, startTransition } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { PowerlineBar, type PowerlineSegmentData } from '@/components/ui/powerline-bar';
import { colorFromName, darkenHex } from '@/components/ui/project-chip';
import { TooltipIconButton } from '@/components/ui/tooltip-icon-button';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { api } from '@/lib/api';
import {
  getGridCells,
  setGridCell,
  clearGridCell,
  getAssignedThreadIds,
  type GridCellAssignments,
} from '@/lib/grid-storage';
import { statusConfig } from '@/lib/thread-utils';
import { toastError } from '@/lib/toast-error';
import { cn, resolveThreadBranch } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { useThreadStore, type ThreadWithMessages } from '@/stores/thread-store';

import { PromptInput } from './PromptInput';
import { SlideUpPrompt } from './SlideUpPrompt';
import { MessageStream, type MessageStreamHandle } from './thread/MessageStream';
import { ThreadPickerDialog } from './ThreadPickerDialog';

const ACTIVE_STATUSES = new Set(['running', 'waiting', 'pending']);

const MAX_GRID_COLS = 5;
const MAX_GRID_ROWS = 5;

function GridPicker({
  cols,
  rows,
  onChange,
}: {
  cols: number;
  rows: number;
  onChange: (cols: number, rows: number) => void;
}) {
  const [hoverCol, setHoverCol] = useState(0);
  const [hoverRow, setHoverRow] = useState(0);
  const [open, setOpen] = useState(false);

  const displayCol = open && hoverCol > 0 ? hoverCol : cols;
  const displayRow = open && hoverRow > 0 ? hoverRow : rows;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" className="h-6 min-w-0 gap-1.5 px-2 text-[10px]">
          <Grid2x2 className="icon-sm" />
          {cols}×{rows}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="end" sideOffset={4}>
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${MAX_GRID_COLS}, 1fr)` }}
          onMouseLeave={() => {
            setHoverCol(0);
            setHoverRow(0);
          }}
        >
          {Array.from({ length: MAX_GRID_ROWS }, (_, r) =>
            Array.from({ length: MAX_GRID_COLS }, (_, c) => {
              const isHighlighted = c + 1 <= displayCol && r + 1 <= displayRow;
              return (
                <button
                  key={`${c}-${r}`}
                  className={cn(
                    'w-5 h-5 rounded-sm border transition-colors',
                    isHighlighted
                      ? 'bg-primary border-primary'
                      : 'bg-muted/40 border-border hover:border-muted-foreground/40',
                  )}
                  onMouseEnter={() => {
                    setHoverCol(c + 1);
                    setHoverRow(r + 1);
                  }}
                  onClick={() => {
                    onChange(c + 1, r + 1);
                    setOpen(false);
                  }}
                />
              );
            }),
          )}
        </div>
        <p className="mt-2 text-center text-[10px] text-muted-foreground">
          {displayCol}×{displayRow}
        </p>
      </PopoverContent>
    </Popover>
  );
}

/** A single column that loads and streams a thread in real-time */
const ThreadColumn = memo(function ThreadColumn({
  threadId,
  onRemove,
}: {
  threadId: string;
  onRemove?: () => void;
}) {
  const { t } = useTranslation();
  const [thread, setThread] = useState<ThreadWithMessages | null>(null);
  const [loading, setLoading] = useState(true);
  const streamRef = useRef<MessageStreamHandle>(null);
  const projects = useProjectStore((s) => s.projects);

  // Subscribe only to this thread's status — avoids re-rendering when other threads change
  const liveStatus = useThreadStore((s) => {
    for (const threads of Object.values(s.threadsByProject)) {
      const found = threads.find((t) => t.id === threadId);
      if (found) return found.status;
    }
    return null;
  });

  // Load thread data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getThread(threadId, 50).then((result) => {
      if (cancelled) return;
      if (result.isOk()) {
        setThread(result.value as ThreadWithMessages);
      }
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [threadId]);

  // Poll for updates every 3 seconds to get streaming content (only for active threads)
  const isActive = liveStatus ? ACTIVE_STATUSES.has(liveStatus) : true;
  useEffect(() => {
    if (!isActive) return;
    const interval = setInterval(async () => {
      const result = await api.getThread(threadId, 50);
      if (result.isOk()) {
        setThread(result.value as ThreadWithMessages);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [threadId, isActive]);

  const threadProjectId = thread?.projectId;
  const threadProject = useMemo(() => {
    if (!threadProjectId) return null;
    return projects.find((p) => p.id === threadProjectId) ?? null;
  }, [threadProjectId, projects]);
  const projectName = threadProject?.name ?? '';

  const [sending, setSending] = useState(false);

  const handleSend = useCallback(
    async (
      prompt: string,
      opts: {
        provider?: string;
        model: string;
        mode: string;
        fileReferences?: { path: string; type?: 'file' | 'folder' }[];
        symbolReferences?: {
          path: string;
          name: string;
          kind: string;
          line: number;
          endLine?: number;
        }[];
      },
      images?: any[],
    ) => {
      if (sending || !thread) return;
      setSending(true);
      // Scroll to bottom when user sends
      streamRef.current?.scrollToBottom();
      startTransition(() => {
        useAppStore
          .getState()
          .appendOptimisticMessage(
            threadId,
            prompt,
            images,
            opts.model as any,
            opts.mode as any,
            opts.fileReferences,
          );
      });
      const { allowedTools, disallowedTools } = deriveToolLists(
        useSettingsStore.getState().toolPermissions,
      );
      const result = await api.sendMessage(
        threadId,
        prompt,
        {
          provider: opts.provider || undefined,
          model: opts.model || undefined,
          permissionMode: opts.mode || undefined,
          allowedTools,
          disallowedTools,
          fileReferences: opts.fileReferences,
          symbolReferences: opts.symbolReferences,
        },
        images,
      );
      if (result.isErr()) {
        const err = result.error;
        if (err.type === 'INTERNAL') {
          toast.error(t('thread.sendFailed'));
        } else {
          toast.error(t('thread.sendFailedGeneric', { error: err.message }));
        }
      }
      setSending(false);
    },
    [sending, threadId, thread, t],
  );

  const handleStop = useCallback(async () => {
    await api.stopThread(threadId);
  }, [threadId]);

  const status = liveStatus ?? thread?.status ?? 'idle';
  const StatusIcon = statusConfig[status]?.icon ?? Loader2;
  const statusClass = statusConfig[status]?.className ?? '';

  if (loading) {
    return (
      <div className="flex min-h-0 items-center justify-center rounded-sm border border-border">
        <Loader2 className="icon-lg animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex min-h-0 items-center justify-center rounded-sm border border-border text-xs text-muted-foreground">
        {t('thread.notFound', 'Thread not found')}
      </div>
    );
  }

  const isRunning = status === 'running';

  return (
    <div
      className="group/col flex min-w-0 flex-col overflow-hidden rounded-sm border border-border"
      data-testid={`grid-column-${threadId}`}
    >
      {/* Column header */}
      <div className="flex-shrink-0 border-b border-border bg-sidebar/50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <StatusIcon className={cn('icon-sm shrink-0', statusClass)} />
          <span className="flex-1 truncate text-sm font-medium" title={thread.title}>
            {thread.title}
          </span>
          {onRemove && (
            <TooltipIconButton
              tooltip={t('live.removeFromGrid', 'Remove from grid')}
              onClick={onRemove}
              className="h-5 w-5 shrink-0 opacity-0 transition-opacity group-hover/col:opacity-100"
              data-testid={`grid-remove-${threadId}`}
            >
              <X className="icon-xs" />
            </TooltipIconButton>
          )}
        </div>
        {(projectName || resolveThreadBranch(thread) || thread.baseBranch) && (
          <div className="mt-1 min-w-0 overflow-hidden">
            <PowerlineBar
              data-testid={`grid-column-powerline-${threadId}`}
              size="sm"
              segments={(() => {
                const baseColor =
                  threadProject?.color || (projectName ? colorFromName(projectName) : '#52525b');
                const segs: PowerlineSegmentData[] = [];
                if (projectName) {
                  segs.push({
                    key: 'project',
                    icon: FolderOpen,
                    label: projectName,
                    color: baseColor,
                  });
                }
                if (resolveThreadBranch(thread) || thread.baseBranch) {
                  segs.push({
                    key: 'branch',
                    icon: GitBranch,
                    label: (resolveThreadBranch(thread) || thread.baseBranch)!,
                    color: projectName ? darkenHex(baseColor, 0.12) : baseColor,
                  });
                }
                return segs;
              })()}
            />
          </div>
        )}
      </div>

      {/* Messages — uses the same MessageStream as the main ThreadView */}
      <MessageStream
        ref={streamRef}
        compact
        threadId={thread.id}
        status={status}
        messages={thread.messages ?? []}
        threadEvents={thread.threadEvents}
        compactionEvents={thread.compactionEvents}
        initInfo={thread.initInfo}
        resultInfo={thread.resultInfo}
        waitingReason={thread.waitingReason}
        pendingPermission={thread.pendingPermission}
        isExternal={thread.provider === 'external'}
        model={thread.model}
        permissionMode={thread.permissionMode}
        onSend={handleSend}
        className="min-h-0 flex-1"
        footer={
          <PromptInput
            onSubmit={handleSend}
            onStop={handleStop}
            loading={sending}
            running={isRunning}
            threadId={thread.id}
            placeholder={t('thread.nextPrompt')}
          />
        }
      />
    </div>
  );
});

export function LiveColumnsView() {
  const { t } = useTranslation();
  useMinuteTick();
  const projects = useProjectStore((s) => s.projects);
  const loadThreadsForProject = useThreadStore((s) => s.loadThreadsForProject);
  const toolPermissions = useSettingsStore((s) => s.toolPermissions);
  const [gridCols, setGridCols] = useState(() => {
    const saved = localStorage.getItem('funny:grid-cols');
    return saved ? Math.min(Math.max(Number(saved), 1), MAX_GRID_COLS) : 2;
  });
  const [gridRows, setGridRows] = useState(() => {
    const saved = localStorage.getItem('funny:grid-rows');
    return saved ? Math.min(Math.max(Number(saved), 1), MAX_GRID_ROWS) : 2;
  });
  const maxSlots = gridCols * gridRows;

  // Add-thread state
  const [slideUpOpen, setSlideUpOpen] = useState(false);
  const [slideUpProjectId, setSlideUpProjectId] = useState<string | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState('');

  const handleAddThread = useCallback((pid: string) => {
    setSlideUpProjectId(pid);
    setSlideUpOpen(true);
  }, []);

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

      if (opts.sendToBacklog) {
        const result = await api.createIdleThread({
          projectId: slideUpProjectId,
          title: prompt.slice(0, 200),
          mode: threadMode,
          baseBranch: opts.baseBranch,
          prompt,
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
      }

      const { allowedTools, disallowedTools } = deriveToolLists(toolPermissions);
      const result = await api.createThread({
        projectId: slideUpProjectId,
        title: prompt.slice(0, 200),
        mode: threadMode,
        model: opts.model,
        prompt,
        permissionMode: opts.mode,
        allowedTools,
        disallowedTools,
        baseBranch: opts.baseBranch,
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
    },
    [slideUpProjectId, creating, projects, toolPermissions, loadThreadsForProject, t],
  );

  const filteredProjects = projectSearch
    ? projects.filter((p) => p.name.toLowerCase().includes(projectSearch.toLowerCase()))
    : projects;

  // Ensure threads are loaded for all projects and refresh periodically
  useEffect(() => {
    const load = () => {
      for (const project of projects) {
        loadThreadsForProject(project.id);
      }
    };
    load();
    const interval = setInterval(load, 5000);
    return () => clearInterval(interval);
  }, [projects, loadThreadsForProject]);

  // --- Grid cell assignments (manual selection) ---
  const [gridCells, setGridCells] = useState<GridCellAssignments>(getGridCells);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerCellIndex, setPickerCellIndex] = useState(0);

  const assignedThreadIds = useMemo(() => getAssignedThreadIds(gridCells), [gridCells]);

  const handlePickThread = useCallback((cellIndex: number) => {
    setPickerCellIndex(cellIndex);
    setPickerOpen(true);
  }, []);

  const handleThreadPicked = useCallback(
    (threadId: string) => {
      setGridCells(setGridCell(pickerCellIndex, threadId));
    },
    [pickerCellIndex],
  );

  const handleRemoveFromGrid = useCallback((cellIndex: number) => {
    setGridCells(clearGridCell(cellIndex));
  }, []);

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden" data-testid="grid-view">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <span className="flex items-center gap-2 text-sm font-medium">
          <LayoutGrid className="icon-sm text-muted-foreground" /> {t('live.title', 'Grid')}
        </span>
        {/* Create new thread */}
        <Popover
          open={projectPickerOpen}
          onOpenChange={(v) => {
            setProjectPickerOpen(v);
            if (!v) setProjectSearch('');
          }}
        >
          <PopoverTrigger asChild>
            <Button variant="ghost" size="icon" className="h-7 w-7" data-testid="grid-new-thread">
              <Plus className="icon-base" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64 p-0">
            <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2.5">
              <Search className="icon-base shrink-0 text-muted-foreground" />
              <Input
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
                placeholder={t('kanban.searchProject', 'Search project...')}
                className="h-auto flex-1 rounded-none border-0 bg-transparent px-0 py-0 text-sm shadow-none placeholder:text-muted-foreground focus-visible:ring-0 focus-visible:ring-offset-0"
                autoFocus
              />
            </div>
            <div className="max-h-56 overflow-y-auto py-1">
              {filteredProjects.length === 0 ? (
                <div className="py-3 text-center text-sm text-muted-foreground">
                  {t('commandPalette.noResults', 'No results')}
                </div>
              ) : (
                filteredProjects.map((p) => (
                  <button
                    key={p.id}
                    className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-accent"
                    onClick={() => {
                      setProjectPickerOpen(false);
                      setProjectSearch('');
                      handleAddThread(p.id);
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

        {/* Grid size picker */}
        <div className="ml-auto">
          <GridPicker
            cols={gridCols}
            rows={gridRows}
            onChange={(c, r) => {
              setGridCols(c);
              setGridRows(r);
              localStorage.setItem('funny:grid-cols', String(c));
              localStorage.setItem('funny:grid-rows', String(r));
            }}
          />
        </div>
      </div>

      {/* Grid */}
      <div
        data-testid="grid-container"
        className="min-h-0 flex-1 gap-2 overflow-auto p-2"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${gridCols}, minmax(400px, 1fr))`,
          gridTemplateRows: `repeat(${gridRows}, 1fr)`,
        }}
      >
        {Array.from({ length: maxSlots }, (_, i) => {
          const threadId = gridCells[String(i)];
          if (threadId) {
            return (
              <ThreadColumn
                key={threadId}
                threadId={threadId}
                onRemove={() => handleRemoveFromGrid(i)}
              />
            );
          }
          return (
            <button
              key={`empty-${i}`}
              onClick={() => handlePickThread(i)}
              className="flex flex-col items-center justify-center gap-2 rounded-sm border-2 border-dashed border-border/60 bg-muted/10 transition-colors hover:border-primary/50 hover:bg-muted/30"
              data-testid={`grid-empty-cell-${i}`}
            >
              <Plus className="h-8 w-8 text-muted-foreground/40" />
              <span className="text-xs text-muted-foreground/60">
                {t('live.addThread', 'Add thread')}
              </span>
            </button>
          );
        })}
      </div>

      <ThreadPickerDialog
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={handleThreadPicked}
        excludeIds={assignedThreadIds}
      />

      <SlideUpPrompt
        open={slideUpOpen}
        onClose={() => setSlideUpOpen(false)}
        onSubmit={handlePromptSubmit}
        loading={creating}
        projectId={slideUpProjectId}
      />
    </div>
  );
}
