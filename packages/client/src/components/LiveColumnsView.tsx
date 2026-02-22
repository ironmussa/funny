import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo, memo, startTransition } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { motion, useReducedMotion } from 'motion/react';
import { api } from '@/lib/api';
import { useThreadStore, type ThreadWithMessages } from '@/stores/thread-store';
import { useProjectStore } from '@/stores/project-store';
import { cn } from '@/lib/utils';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Input } from '@/components/ui/input';
import { Loader2, Columns3, Grid2x2, Plus, Search } from 'lucide-react';
import { statusConfig, timeAgo, resolveModelLabel } from '@/lib/thread-utils';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { ToolCallCard } from './ToolCallCard';
import { ToolCallGroup } from './ToolCallGroup';
import { PromptInput } from './PromptInput';
import { SlideUpPrompt } from './SlideUpPrompt';
import { useAppStore } from '@/stores/app-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { toast } from 'sonner';
import type { Thread } from '@funny/shared';

const ACTIVE_STATUSES = new Set(['running', 'waiting', 'pending']);
const FINISHED_STATUSES = new Set(['completed', 'failed', 'stopped', 'interrupted']);

const MAX_GRID_COLS = 5;
const MAX_GRID_ROWS = 5;

function GridPicker({ cols, rows, onChange }: { cols: number; rows: number; onChange: (cols: number, rows: number) => void }) {
  const [hoverCol, setHoverCol] = useState(0);
  const [hoverRow, setHoverRow] = useState(0);
  const [open, setOpen] = useState(false);

  const displayCol = open && hoverCol > 0 ? hoverCol : cols;
  const displayRow = open && hoverRow > 0 ? hoverRow : rows;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" className="text-[10px] h-6 px-2 gap-1.5 min-w-0">
          <Grid2x2 className="h-3.5 w-3.5" />
          {cols}×{rows}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-auto p-3" align="end" sideOffset={4}>
        <div
          className="grid gap-1"
          style={{ gridTemplateColumns: `repeat(${MAX_GRID_COLS}, 1fr)` }}
          onMouseLeave={() => { setHoverCol(0); setHoverRow(0); }}
        >
          {Array.from({ length: MAX_GRID_ROWS }, (_, r) =>
            Array.from({ length: MAX_GRID_COLS }, (_, c) => {
              const isHighlighted = (c + 1) <= displayCol && (r + 1) <= displayRow;
              return (
                <button
                  key={`${c}-${r}`}
                  className={cn(
                    'w-5 h-5 rounded-sm border transition-colors',
                    isHighlighted
                      ? 'bg-primary border-primary'
                      : 'bg-muted/40 border-border hover:border-muted-foreground/40'
                  )}
                  onMouseEnter={() => { setHoverCol(c + 1); setHoverRow(r + 1); }}
                  onClick={() => { onChange(c + 1, r + 1); setOpen(false); }}
                />
              );
            })
          )}
        </div>
        <p className="text-[10px] text-muted-foreground text-center mt-2">
          {displayCol}×{displayRow}
        </p>
      </PopoverContent>
    </Popover>
  );
}

const remarkPlugins = [remarkGfm];

const markdownComponents = {
  code: ({ className, children, ...props }: any) => {
    const isBlock = className?.startsWith('language-');
    return isBlock
      ? <code className={cn('block bg-muted p-2 rounded text-xs font-mono overflow-x-auto', className)} {...props}>{children}</code>
      : <code className="bg-muted px-1 py-0.5 rounded text-xs font-mono" {...props}>{children}</code>;
  },
  pre: ({ children }: any) => <pre className="bg-muted rounded p-2 font-mono overflow-x-auto my-2">{children}</pre>,
};

type ToolItem =
  | { type: 'toolcall'; tc: any }
  | { type: 'toolcall-group'; name: string; calls: any[] };

type RenderItem =
  | { type: 'message'; msg: any }
  | ToolItem
  | { type: 'toolcall-run'; items: ToolItem[] };

function buildGroupedRenderItems(messages: any[]): RenderItem[] {
  const flat: ({ type: 'message'; msg: any } | { type: 'toolcall'; tc: any })[] = [];
  for (const msg of messages) {
    if (msg.content && msg.content.trim()) {
      flat.push({ type: 'message', msg });
    }
    for (const tc of msg.toolCalls ?? []) {
      flat.push({ type: 'toolcall', tc });
    }
  }

  const noGroup = new Set(['AskUserQuestion', 'ExitPlanMode']);
  const grouped: RenderItem[] = [];
  for (const item of flat) {
    if (item.type === 'toolcall') {
      const last = grouped[grouped.length - 1];
      if (!noGroup.has(item.tc.name) && last?.type === 'toolcall' && (last as any).tc.name === item.tc.name) {
        grouped[grouped.length - 1] = { type: 'toolcall-group', name: item.tc.name, calls: [(last as any).tc, item.tc] };
      } else if (!noGroup.has(item.tc.name) && last?.type === 'toolcall-group' && last.name === item.tc.name) {
        last.calls.push(item.tc);
      } else {
        grouped.push(item);
      }
    } else {
      grouped.push(item);
    }
  }

  // Deduplicate TodoWrite
  let lastTodoIdx = -1;
  for (let i = grouped.length - 1; i >= 0; i--) {
    const g = grouped[i];
    if ((g.type === 'toolcall' && g.tc.name === 'TodoWrite') ||
      (g.type === 'toolcall-group' && g.name === 'TodoWrite')) {
      lastTodoIdx = i;
      break;
    }
  }
  const deduped: RenderItem[] = [];
  for (let i = 0; i < grouped.length; i++) {
    const g = grouped[i];
    const isTodoItem = (g.type === 'toolcall' && g.tc.name === 'TodoWrite') ||
      (g.type === 'toolcall-group' && g.name === 'TodoWrite');
    if (isTodoItem && i !== lastTodoIdx) continue;
    if (isTodoItem && g.type === 'toolcall-group') {
      deduped.push({ type: 'toolcall', tc: g.calls[g.calls.length - 1] });
    } else {
      deduped.push(g);
    }
  }

  const final: RenderItem[] = [];
  for (const item of deduped) {
    if (item.type === 'toolcall' || item.type === 'toolcall-group') {
      const last = final[final.length - 1];
      if (last?.type === 'toolcall-run') {
        last.items.push(item);
      } else if (last?.type === 'toolcall' || last?.type === 'toolcall-group') {
        final[final.length - 1] = { type: 'toolcall-run', items: [last, item] };
      } else {
        final.push(item);
      }
    } else {
      final.push(item);
    }
  }

  return final;
}

const D4C_FRAMES = ['🐇', '🌀', '🐰', '⭐'];
const D4C_INTERVAL = 600;

function D4CAnimation() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % D4C_FRAMES.length), D4C_INTERVAL);
    return () => clearInterval(id);
  }, []);
  return <span className="inline-block text-xs leading-none w-4 text-center">{D4C_FRAMES[frame]}</span>;
}

/** A single column that loads and streams a thread in real-time */
const ThreadColumn = memo(function ThreadColumn({ threadId }: { threadId: string }) {
  const { t } = useTranslation();
  const prefersReducedMotion = useReducedMotion();
  const [thread, setThread] = useState<ThreadWithMessages | null>(null);
  const [loading, setLoading] = useState(true);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const userHasScrolledUp = useRef(false);
  const smoothScrollPending = useRef(false);
  const projects = useProjectStore(s => s.projects);

  // Subscribe to real-time WS updates for this thread via the store
  const threadsByProject = useThreadStore(s => s.threadsByProject);

  // Find the latest status for this thread from the store
  const liveStatus = useMemo(() => {
    for (const threads of Object.values(threadsByProject)) {
      const found = threads.find(t => t.id === threadId);
      if (found) return found.status;
    }
    return null;
  }, [threadsByProject, threadId]);

  // Load thread data
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api.getThread(threadId, 50).then(result => {
      if (cancelled) return;
      if (result.isOk()) {
        setThread(result.value as ThreadWithMessages);
      }
      setLoading(false);
    });
    return () => { cancelled = true; };
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

  // Auto-scroll to bottom
  useLayoutEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport || !thread) return;
    if (!userHasScrolledUp.current) {
      if (smoothScrollPending.current) {
        smoothScrollPending.current = false;
        requestAnimationFrame(() => {
          viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
        });
      } else {
        viewport.scrollTop = viewport.scrollHeight;
      }
    }
  }, [thread?.messages?.length, thread?.messages?.at(-1)?.content?.length, thread?.messages?.at(-1)?.toolCalls?.length]);

  const handleScroll = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const { scrollTop, scrollHeight, clientHeight } = viewport;
    const isAtBottom = scrollHeight - scrollTop - clientHeight <= 80;
    userHasScrolledUp.current = !isAtBottom;
  }, []);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, [handleScroll]);

  const projectName = useMemo(() => {
    if (!thread) return '';
    const p = projects.find(p => p.id === thread.projectId);
    return p?.name ?? '';
  }, [thread?.projectId, projects]);

  const [sending, setSending] = useState(false);

  const handleSend = useCallback(async (prompt: string, opts: { provider?: string; model: string; mode: string; fileReferences?: { path: string }[] }, images?: any[]) => {
    if (sending || !thread) return;
    setSending(true);
    // Always scroll to bottom when the user sends a message (smooth)
    userHasScrolledUp.current = false;
    smoothScrollPending.current = true;
    startTransition(() => {
      useAppStore.getState().appendOptimisticMessage(
        threadId,
        prompt,
        images,
        opts.model as any,
        opts.mode as any
      );
    });
    const { allowedTools, disallowedTools } = deriveToolLists(useSettingsStore.getState().toolPermissions);
    await api.sendMessage(threadId, prompt, { provider: opts.provider || undefined, model: opts.model || undefined, permissionMode: opts.mode || undefined, allowedTools, disallowedTools, fileReferences: opts.fileReferences }, images);
    setSending(false);
  }, [sending, threadId, thread]);

  const handleStop = useCallback(async () => {
    await api.stopThread(threadId);
  }, [threadId]);

  const status = liveStatus ?? thread?.status ?? 'idle';
  const StatusIcon = statusConfig[status]?.icon ?? Loader2;
  const statusClass = statusConfig[status]?.className ?? '';

  if (loading) {
    return (
      <div className="flex items-center justify-center border border-border rounded-sm min-h-0">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex items-center justify-center border border-border rounded-sm text-muted-foreground text-xs min-h-0">
        {t('thread.notFound', 'Thread not found')}
      </div>
    );
  }

  const isRunning = status === 'running';

  return (
    <div className="flex flex-col min-w-0 border border-border rounded-sm overflow-hidden">
      {/* Column header */}
      <div className="flex-shrink-0 border-b border-border px-3 py-2 bg-sidebar/50">
        <div className="flex items-center gap-2 min-w-0">
          <StatusIcon className={cn('h-3.5 w-3.5 shrink-0', statusClass)} />
          <span className="text-sm font-medium truncate flex-1" title={thread.title}>
            {thread.title}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-1">
          {projectName && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-normal">
              {projectName}
            </Badge>
          )}
          {(thread.branch || thread.baseBranch) && (
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-mono font-normal truncate max-w-[120px]">
              {thread.branch || thread.baseBranch}
            </Badge>
          )}
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0 px-2 [&_[data-radix-scroll-area-viewport]>div]:!flex [&_[data-radix-scroll-area-viewport]>div]:!flex-col [&_[data-radix-scroll-area-viewport]>div]:min-h-full" viewportRef={scrollViewportRef}>
        <div className="space-y-2 py-2 mt-auto">
          {buildGroupedRenderItems(thread.messages ?? []).map((item) => {
            const renderToolItem = (ti: ToolItem) => {
              if (ti.type === 'toolcall') {
                return (
                  <div key={ti.tc.id}>
                    <ToolCallCard
                      name={ti.tc.name}
                      input={ti.tc.input}
                      output={ti.tc.output}
                    />
                  </div>
                );
              }
              if (ti.type === 'toolcall-group') {
                return (
                  <div key={ti.calls[0].id}>
                    <ToolCallGroup name={ti.name} calls={ti.calls} />
                  </div>
                );
              }
              return null;
            };

            if (item.type === 'message') {
              const msg = item.msg;
              return (
                <div
                  key={msg.id}
                  className={cn(
                    'text-sm leading-relaxed',
                    msg.role === 'user'
                      ? 'max-w-[90%] ml-auto rounded-md px-2 py-1.5 bg-foreground text-background'
                      : 'w-full text-foreground'
                  )}
                >
                  {msg.role === 'user' ? (
                    <pre className="whitespace-pre-wrap font-mono text-xs break-words overflow-x-auto max-h-80 overflow-y-auto">
                      {msg.content.trim()}
                    </pre>
                  ) : (
                    <div className="prose prose-sm max-w-none break-words overflow-x-auto">
                      <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
                        {msg.content.trim()}
                      </ReactMarkdown>
                    </div>
                  )}
                </div>
              );
            }

            if (item.type === 'toolcall' || item.type === 'toolcall-group') {
              return renderToolItem(item);
            }

            if (item.type === 'toolcall-run') {
              return (
                <div key={item.items[0].type === 'toolcall' ? item.items[0].tc.id : item.items[0].calls[0].id} className="space-y-0.5">
                  {item.items.map(renderToolItem)}
                </div>
              );
            }

            return null;
          })}

          {isRunning && (
            <div className="flex items-center gap-1.5 text-muted-foreground text-xs py-0.5">
              <D4CAnimation />
              <span>{t('thread.agentWorking')}</span>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Prompt input */}
      <PromptInput
        onSubmit={handleSend}
        onStop={handleStop}
        loading={sending}
        running={isRunning}
        placeholder={t('thread.nextPrompt')}
      />
    </div>
  );
});

export function LiveColumnsView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  useMinuteTick();
  const threadsByProject = useThreadStore(s => s.threadsByProject);
  const projects = useProjectStore(s => s.projects);
  const loadThreadsForProject = useThreadStore(s => s.loadThreadsForProject);
  const toolPermissions = useSettingsStore(s => s.toolPermissions);
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

  const handlePromptSubmit = useCallback(async (
    prompt: string,
    opts: { model: string; mode: string; threadMode?: string; baseBranch?: string; sendToBacklog?: boolean },
    images?: any[]
  ): Promise<boolean> => {
    if (!slideUpProjectId || creating) return false;
    setCreating(true);

    const slideUpProject = projects.find(p => p.id === slideUpProjectId);
    const threadMode = (opts.threadMode as 'local' | 'worktree') || slideUpProject?.defaultMode || 'worktree';

    if (opts.sendToBacklog) {
      const result = await api.createIdleThread({
        projectId: slideUpProjectId,
        title: prompt.slice(0, 200),
        mode: threadMode,
        baseBranch: opts.baseBranch,
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
      toast.error(result.error.message);
      setCreating(false);
      return false;
    }

    await loadThreadsForProject(slideUpProjectId);
    setCreating(false);
    toast.success(t('toast.threadCreated', { title: prompt.slice(0, 200) }));
    return true;
  }, [slideUpProjectId, creating, projects, toolPermissions, loadThreadsForProject, t]);

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

  // Collect active threads + recent finished threads (matching sidebar activity)
  const activeThreads = useMemo(() => {
    const running: Thread[] = [];
    const finished: Thread[] = [];
    for (const threads of Object.values(threadsByProject)) {
      for (const thread of threads) {
        if (thread.archived) continue;
        if (ACTIVE_STATUSES.has(thread.status)) {
          running.push(thread);
        } else if (FINISHED_STATUSES.has(thread.status)) {
          finished.push(thread);
        }
      }
    }
    // Sort finished by completion date
    finished.sort((a, b) => {
      const dateA = new Date(a.completedAt ?? a.createdAt).getTime();
      const dateB = new Date(b.completedAt ?? b.createdAt).getTime();
      return dateB - dateA;
    });
    // Active threads first (sorted by creation), then fill remaining slots with recent finished
    running.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const remainingSlots = Math.max(0, maxSlots - running.length);
    return [...running, ...finished.slice(0, remainingSlots)];
  }, [threadsByProject, maxSlots]);

  if (activeThreads.length === 0) {
    return (
      <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden">
        <div className="flex-shrink-0 border-b border-border px-4 py-2 flex items-center gap-2">
          <Columns3 className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">{t('live.title', 'Grid')}</span>
          <Popover open={projectPickerOpen} onOpenChange={(v) => { setProjectPickerOpen(v); if (!v) setProjectSearch(''); }}>
            <PopoverTrigger asChild>
              <Button variant="ghost" className="h-6 px-2 text-[10px] gap-1.5 min-w-0">
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-56 p-0">
              <div className="flex items-center gap-2 px-2.5 py-2 border-b border-border/50">
                <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <Input
                  value={projectSearch}
                  onChange={(e) => setProjectSearch(e.target.value)}
                  placeholder={t('kanban.searchProject', 'Search project...')}
                  className="flex-1 h-auto border-0 bg-transparent text-xs shadow-none focus-visible:ring-0 px-0 py-0 placeholder:text-muted-foreground"
                  autoFocus
                />
              </div>
              <div className="max-h-48 overflow-y-auto py-1">
                {filteredProjects.length === 0 ? (
                  <div className="text-xs text-muted-foreground text-center py-3">
                    {t('commandPalette.noResults', 'No results')}
                  </div>
                ) : (
                  filteredProjects.map((p) => (
                    <button
                      key={p.id}
                      className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-accent transition-colors flex items-center gap-2"
                      onClick={() => {
                        setProjectPickerOpen(false);
                        setProjectSearch('');
                        handleAddThread(p.id);
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
        </div>
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center space-y-2">
            <Columns3 className="h-10 w-10 mx-auto text-muted-foreground/40" />
            <p className="text-sm font-medium">{t('live.noActiveThreads', 'No active threads')}</p>
            <p className="text-xs text-muted-foreground/60">{t('live.noActiveThreadsDesc', 'Start some agents and they will appear here in real-time')}</p>
          </div>
        </div>
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

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-border px-4 py-2 flex items-center gap-2">
        <Columns3 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t('live.title', 'Grid')}</span>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
          {activeThreads.filter(t => ACTIVE_STATUSES.has(t.status)).length} {t('live.active', 'active')}
          {activeThreads.some(t => FINISHED_STATUSES.has(t.status)) && (
            <span className="ml-1 text-muted-foreground">
              + {activeThreads.filter(t => FINISHED_STATUSES.has(t.status)).length} {t('live.recent', 'recent')}
            </span>
          )}
        </Badge>

        {/* Add thread */}
        <Popover open={projectPickerOpen} onOpenChange={(v) => { setProjectPickerOpen(v); if (!v) setProjectSearch(''); }}>
          <PopoverTrigger asChild>
            <Button variant="ghost" className="h-6 px-2 text-[10px] gap-1.5 min-w-0">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-56 p-0">
            <div className="flex items-center gap-2 px-2.5 py-2 border-b border-border/50">
              <Search className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <Input
                value={projectSearch}
                onChange={(e) => setProjectSearch(e.target.value)}
                placeholder={t('kanban.searchProject', 'Search project...')}
                className="flex-1 h-auto border-0 bg-transparent text-xs shadow-none focus-visible:ring-0 px-0 py-0 placeholder:text-muted-foreground"
                autoFocus
              />
            </div>
            <div className="max-h-48 overflow-y-auto py-1">
              {filteredProjects.length === 0 ? (
                <div className="text-xs text-muted-foreground text-center py-3">
                  {t('commandPalette.noResults', 'No results')}
                </div>
              ) : (
                filteredProjects.map((p) => (
                  <button
                    key={p.id}
                    className="w-full text-left px-2.5 py-1.5 text-xs hover:bg-accent transition-colors flex items-center gap-2"
                    onClick={() => {
                      setProjectPickerOpen(false);
                      setProjectSearch('');
                      handleAddThread(p.id);
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

        {/* Grid size picker */}
        <div className="ml-auto">
          <GridPicker
            cols={gridCols}
            rows={gridRows}
            onChange={(c, r) => { setGridCols(c); setGridRows(r); localStorage.setItem('funny:grid-cols', String(c)); localStorage.setItem('funny:grid-rows', String(r)); }}
          />
        </div>
      </div>

      {/* Grid */}
      <div
        className="flex-1 min-h-0 overflow-auto p-2 gap-2"
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${gridCols}, minmax(400px, 1fr))`,
          gridTemplateRows: `repeat(${gridRows}, 1fr)`,
        }}
      >
        {activeThreads.slice(0, maxSlots).map(thread => (
          <ThreadColumn key={thread.id} threadId={thread.id} />
        ))}
      </div>

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
