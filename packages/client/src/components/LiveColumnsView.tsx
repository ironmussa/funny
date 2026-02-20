import { useState, useEffect, useRef, useCallback, useLayoutEffect, useMemo, memo } from 'react';
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
import { Loader2, Columns3 } from 'lucide-react';
import { statusConfig, timeAgo, resolveModelLabel } from '@/lib/thread-utils';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { ToolCallCard } from './ToolCallCard';
import { ToolCallGroup } from './ToolCallGroup';
import type { Thread } from '@funny/shared';

const ACTIVE_STATUSES = new Set(['running', 'waiting', 'pending']);

const remarkPlugins = [remarkGfm];

const markdownComponents = {
  code: ({ className, children, ...props }: any) => {
    const isBlock = className?.startsWith('language-');
    return isBlock
      ? <code className={cn('block bg-muted p-1.5 rounded text-[10px] font-mono overflow-x-auto', className)} {...props}>{children}</code>
      : <code className="bg-muted px-1 py-0.5 rounded text-[10px] font-mono" {...props}>{children}</code>;
  },
  pre: ({ children }: any) => <pre className="bg-muted rounded p-1.5 font-mono overflow-x-auto my-1">{children}</pre>,
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

  // Poll for updates every 3 seconds to get streaming content
  useEffect(() => {
    const interval = setInterval(async () => {
      const result = await api.getThread(threadId, 50);
      if (result.isOk()) {
        setThread(result.value as ThreadWithMessages);
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [threadId]);

  // Auto-scroll to bottom
  useLayoutEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport || !thread) return;
    if (!userHasScrolledUp.current) {
      viewport.scrollTop = viewport.scrollHeight;
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

  const status = liveStatus ?? thread?.status ?? 'idle';
  const StatusIcon = statusConfig[status]?.icon ?? Loader2;
  const statusClass = statusConfig[status]?.className ?? '';

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center border-r border-border last:border-r-0">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!thread) {
    return (
      <div className="flex-1 flex items-center justify-center border-r border-border last:border-r-0 text-muted-foreground text-xs">
        {t('thread.notFound', 'Thread not found')}
      </div>
    );
  }

  const isRunning = status === 'running';

  return (
    <div className="flex-1 flex flex-col min-w-0 border-r border-border last:border-r-0 overflow-hidden">
      {/* Column header */}
      <div className="flex-shrink-0 border-b border-border px-3 py-2 bg-sidebar/50">
        <div className="flex items-center gap-2 min-w-0">
          <StatusIcon className={cn('h-3.5 w-3.5 shrink-0', statusClass)} />
          <span className="text-xs font-medium truncate flex-1" title={thread.title}>
            {thread.title}
          </span>
        </div>
        <div className="flex items-center gap-1.5 mt-1">
          {projectName && (
            <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 font-normal">
              {projectName}
            </Badge>
          )}
          {thread.branch && (
            <Badge variant="outline" className="text-[9px] px-1 py-0 h-3.5 font-mono font-normal truncate max-w-[120px]">
              {thread.branch}
            </Badge>
          )}
          <Badge variant="outline" className={cn('text-[9px] px-1 py-0 h-3.5 font-normal', statusClass)}>
            {status}
          </Badge>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 min-h-0 px-2 [&_[data-radix-scroll-area-viewport]>div]:!flex [&_[data-radix-scroll-area-viewport]>div]:!flex-col [&_[data-radix-scroll-area-viewport]>div]:min-h-full" viewportRef={scrollViewportRef}>
        <div className="space-y-2 py-2 mt-auto">
          {buildGroupedRenderItems(thread.messages ?? []).map((item) => {
            const renderToolItem = (ti: ToolItem) => {
              if (ti.type === 'toolcall') {
                return (
                  <div key={ti.tc.id} className="text-[10px]">
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
                  <div key={ti.calls[0].id} className="text-[10px]">
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
                    'text-[11px] leading-relaxed',
                    msg.role === 'user'
                      ? 'max-w-[90%] ml-auto rounded-md px-2 py-1.5 bg-foreground text-background'
                      : 'w-full text-foreground'
                  )}
                >
                  {msg.role === 'user' ? (
                    <pre className="whitespace-pre-wrap font-mono text-[10px] break-words overflow-x-auto max-h-24 overflow-y-auto">
                      {msg.content.trim()}
                    </pre>
                  ) : (
                    <div className="prose prose-sm max-w-none text-[11px] [&_p]:text-[11px] [&_li]:text-[11px] [&_h1]:text-sm [&_h2]:text-xs [&_h3]:text-xs break-words overflow-x-auto">
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
            <div className="flex items-center gap-1.5 text-muted-foreground text-[10px] py-0.5">
              <D4CAnimation />
              <span>{t('thread.agentWorking')}</span>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
});

export function LiveColumnsView() {
  const { t } = useTranslation();
  useMinuteTick();
  const threadsByProject = useThreadStore(s => s.threadsByProject);
  const projects = useProjectStore(s => s.projects);
  const loadThreadsForProject = useThreadStore(s => s.loadThreadsForProject);

  // Ensure threads are loaded for all projects
  useEffect(() => {
    for (const project of projects) {
      loadThreadsForProject(project.id);
    }
  }, [projects, loadThreadsForProject]);

  // Collect all active threads sorted by most recent activity
  const activeThreads = useMemo(() => {
    const all: Thread[] = [];
    for (const threads of Object.values(threadsByProject)) {
      for (const thread of threads) {
        if (ACTIVE_STATUSES.has(thread.status) && !thread.archived) {
          all.push(thread);
        }
      }
    }
    // Sort by createdAt descending (most recent first)
    all.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return all;
  }, [threadsByProject]);

  if (activeThreads.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted-foreground">
        <div className="text-center space-y-2">
          <Columns3 className="h-10 w-10 mx-auto text-muted-foreground/40" />
          <p className="text-sm font-medium">{t('live.noActiveThreads', 'No active threads')}</p>
          <p className="text-xs text-muted-foreground/60">{t('live.noActiveThreadsDesc', 'Start some agents and they will appear here in real-time')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 overflow-hidden">
      {/* Header */}
      <div className="flex-shrink-0 border-b border-border px-4 py-2 flex items-center gap-2">
        <Columns3 className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{t('live.title', 'Live')}</span>
        <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4">
          {activeThreads.length} {t('live.active', 'active')}
        </Badge>
      </div>

      {/* Columns */}
      <div className="flex-1 flex min-h-0 overflow-x-auto">
        {activeThreads.map(thread => (
          <ThreadColumn key={thread.id} threadId={thread.id} />
        ))}
      </div>
    </div>
  );
}
