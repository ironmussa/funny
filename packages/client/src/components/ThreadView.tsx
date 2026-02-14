import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { motion, AnimatePresence } from 'motion/react';
import { useAppStore } from '@/stores/app-store';
import { cn } from '@/lib/utils';
import { Loader2, Clock, Copy, Check, Send, CheckCircle2, XCircle, ArrowDown, ShieldQuestion } from 'lucide-react';
import { api } from '@/lib/api';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';
import { PromptInput } from './PromptInput';
import { ToolCallCard } from './ToolCallCard';
import { ToolCallGroup } from './ToolCallGroup';
import { ImageLightbox } from './ImageLightbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import { ProjectHeader } from './thread/ProjectHeader';
import { NewThreadInput } from './thread/NewThreadInput';
import { AgentResultCard, AgentInterruptedCard, AgentStoppedCard } from './thread/AgentStatusCards';
import { TodoPanel } from './thread/TodoPanel';
import { useTodoSnapshots } from '@/hooks/use-todo-panel';

// Regex to match file paths like /foo/bar.ts, C:\foo\bar.ts, or file_path:line_number patterns
const FILE_PATH_RE = /(?:[A-Za-z]:[\\\/]|\/)[^\s:*?"<>|,()]+(?::\d+)?/g;

function toVscodeUri(filePath: string): string {
  const match = filePath.match(/^(.+):(\d+)$/);
  const path = match ? match[1] : filePath;
  const line = match ? match[2] : null;
  const normalized = path.replace(/\\/g, '/');
  const withLeadingSlash = normalized.startsWith('/') ? normalized : '/' + normalized;
  return `vscode://file${withLeadingSlash}${line ? ':' + line : ''}`;
}

const markdownComponents = {
  a: ({ href, children }: any) => {
    const text = String(children);
    const fileMatch = text.match(FILE_PATH_RE);
    if (fileMatch) {
      return (
        <a href={toVscodeUri(fileMatch[0])} className="text-primary hover:underline" title={`Open in VS Code: ${text}`}>
          {children}
        </a>
      );
    }
    return <a href={href} className="text-primary hover:underline" target="_blank" rel="noopener noreferrer">{children}</a>;
  },
  code: ({ className, children, ...props }: any) => {
    const isBlock = className?.startsWith('language-');
    return isBlock
      ? <code className={cn('block bg-muted p-2 rounded text-xs font-mono overflow-x-auto', className)} {...props}>{children}</code>
      : <code className="bg-muted px-1 py-0.5 rounded text-xs font-mono" {...props}>{children}</code>;
  },
  pre: ({ children }: any) => <pre className="bg-muted rounded p-2 font-mono overflow-x-auto my-2">{children}</pre>,
};

const remarkPlugins = [remarkGfm];

export const MessageContent = memo(function MessageContent({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none">
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      components={markdownComponents}
    >
      {content}
    </ReactMarkdown>
    </div>
  );
});

export function CopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="absolute top-1.5 right-1.5 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
      aria-label="Copy message"
    >
      {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
    </button>
  );
}

export function WaitingActions({ onSend }: { onSend: (text: string) => void }) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmitInput = () => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput('');
  };

  return (
    <div className="rounded-lg border border-status-warning/20 bg-status-warning/5 p-3 space-y-2.5">
      <div className="flex items-center gap-2 text-status-warning/80 text-xs">
        <Clock className="h-3.5 w-3.5" />
        {t('thread.waitingForResponse')}
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => onSend('Continue')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          {t('thread.acceptContinue')}
        </button>
        <button
          onClick={() => onSend('No, do not proceed with that action.')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors"
        >
          <XCircle className="h-3.5 w-3.5" />
          {t('thread.reject')}
        </button>
      </div>

      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmitInput();
            }
          }}
          placeholder={t('thread.waitingInputPlaceholder')}
          className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          onClick={handleSubmitInput}
          disabled={!input.trim()}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
            input.trim()
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'bg-muted text-muted-foreground cursor-not-allowed'
          )}
        >
          <Send className="h-3 w-3" />
          {t('thread.send')}
        </button>
      </div>
    </div>
  );
}

export function PlanWaitingActions({ onSend }: { onSend: (text: string) => void }) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmitInput = () => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput('');
  };

  return (
    <div className="rounded-lg border border-status-warning/20 bg-status-warning/5 p-3 space-y-2.5">
      <div className="flex items-center gap-2 text-status-warning/80 text-xs">
        <Clock className="h-3.5 w-3.5" />
        {t('thread.planWaitingForResponse')}
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => onSend('Plan accepted')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          {t('tools.acceptPlan')}
        </button>
        <button
          onClick={() => onSend('Plan rejected. Do not proceed with this plan.')}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors"
        >
          <XCircle className="h-3.5 w-3.5" />
          {t('thread.rejectPlan')}
        </button>
      </div>

      <div className="flex gap-2">
        <input
          ref={inputRef}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSubmitInput();
            }
          }}
          placeholder={t('thread.waitingInputPlaceholder')}
          className="flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        <button
          onClick={handleSubmitInput}
          disabled={!input.trim()}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
            input.trim()
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'bg-muted text-muted-foreground cursor-not-allowed'
          )}
        >
          <Send className="h-3 w-3" />
          {t('thread.send')}
        </button>
      </div>
    </div>
  );
}

export function PermissionApprovalCard({
  toolName,
  onApprove,
  onDeny
}: {
  toolName: string;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div className="rounded-lg border border-status-warning/20 bg-status-warning/5 p-3 space-y-2.5">
      <div className="flex items-center gap-2 text-status-warning/80 text-xs">
        <ShieldQuestion className="h-3.5 w-3.5" />
        {t('thread.permissionRequired')}
      </div>
      <p className="text-xs text-foreground">
        {t('thread.permissionMessage', { tool: toolName })}
      </p>
      <div className="flex gap-2">
        <button
          onClick={onApprove}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          {t('thread.approvePermission')}
        </button>
        <button
          onClick={onDeny}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors"
        >
          <XCircle className="h-3.5 w-3.5" />
          {t('thread.denyPermission')}
        </button>
      </div>
    </div>
  );
}

type ToolItem =
  | { type: 'toolcall'; tc: any }
  | { type: 'toolcall-group'; name: string; calls: any[] };

type RenderItem =
  | { type: 'message'; msg: any }
  | ToolItem
  | { type: 'toolcall-run'; items: ToolItem[] };

function buildGroupedRenderItems(messages: any[]): RenderItem[] {
  // Flatten all messages into a single stream of items
  const flat: ({ type: 'message'; msg: any } | { type: 'toolcall'; tc: any })[] = [];
  for (const msg of messages) {
    // Only add message bubble if there's actual text content
    // Tool calls are handled separately below
    if (msg.content && msg.content.trim()) {
      flat.push({ type: 'message', msg });
    }
    for (const tc of msg.toolCalls ?? []) {
      flat.push({ type: 'toolcall', tc });
    }
  }

  // Tool calls that should never be grouped (interactive, need individual response, or need per-item scroll tracking)
  const noGroup = new Set(['AskUserQuestion', 'ExitPlanMode', 'TodoWrite']);

  // Group consecutive same-type tool calls (across message boundaries)
  const grouped: RenderItem[] = [];
  for (const item of flat) {
    if (item.type === 'toolcall') {
      const last = grouped[grouped.length - 1];
      if (!noGroup.has(item.tc.name) && last?.type === 'toolcall' && (last as any).tc.name === item.tc.name) {
        grouped[grouped.length - 1] = {
          type: 'toolcall-group',
          name: item.tc.name,
          calls: [(last as any).tc, item.tc],
        };
      } else if (!noGroup.has(item.tc.name) && last?.type === 'toolcall-group' && last.name === item.tc.name) {
        last.calls.push(item.tc);
      } else {
        grouped.push(item);
      }
    } else {
      grouped.push(item);
    }
  }

  // Wrap consecutive tool call items into a single toolcall-run for tighter spacing
  const final: RenderItem[] = [];
  for (const item of grouped) {
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

export function ThreadView() {
  const { t } = useTranslation();
  const activeThread = useAppStore(s => s.activeThread);
  const selectedThreadId = useAppStore(s => s.selectedThreadId);
  const selectedProjectId = useAppStore(s => s.selectedProjectId);
  const newThreadProjectId = useAppStore(s => s.newThreadProjectId);
  const [sending, setSending] = useState(false);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const userHasScrolledUp = useRef(false);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxImages, setLightboxImages] = useState<{ src: string; alt: string }[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [todoPanelDismissed, setTodoPanelDismissed] = useState(false);
  const [currentSnapshotIdx, setCurrentSnapshotIdx] = useState(-1);
  const snapshots = useTodoSnapshots();

  // Map tool call IDs to snapshot indices for data-attribute lookup
  const snapshotMap = useMemo(() => {
    const map = new Map<string, number>();
    snapshots.forEach((s, i) => map.set(s.toolCallId, i));
    return map;
  }, [snapshots]);

  // Reset dismissed state and snapshot index when switching threads
  useEffect(() => {
    setTodoPanelDismissed(false);
    setCurrentSnapshotIdx(-1);
  }, [activeThread?.id]);

  // Scroll to bottom when opening or switching threads
  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport || !activeThread) return;

    // Reset the scroll-up flag and scroll to bottom
    userHasScrolledUp.current = false;
    viewport.scrollTop = viewport.scrollHeight;
  }, [activeThread?.id]);

  // Derive displayed snapshot — only when scroll handler has detected a position
  const currentSnapshot = currentSnapshotIdx >= 0 && currentSnapshotIdx < snapshots.length
    ? snapshots[currentSnapshotIdx]
    : null;

  const openLightbox = useCallback((images: { src: string; alt: string }[], index: number) => {
    setLightboxImages(images);
    setLightboxIndex(index);
    setLightboxOpen(true);
  }, []);

  const lastMessage = activeThread?.messages?.[activeThread.messages.length - 1];
  const scrollFingerprint = [
    activeThread?.messages?.length,
    lastMessage?.content?.length,
    lastMessage?.toolCalls?.length,
    activeThread?.status,
  ].join(':');

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport;
      const hasOverflow = scrollHeight > clientHeight + 10;
      const isAtBottom = scrollHeight - scrollTop - clientHeight <= 80;
      userHasScrolledUp.current = !isAtBottom;
      setShowScrollDown(hasOverflow && !isAtBottom);

      // Update current TodoWrite snapshot based on scroll position
      const todoEls = document.querySelectorAll<HTMLElement>('[data-todo-snapshot]');
      if (todoEls.length === 0) {
        setCurrentSnapshotIdx(-1);
        return;
      }

      // When auto-scrolling at the bottom, always show the latest snapshot
      if (isAtBottom) {
        let maxIdx = -1;
        todoEls.forEach((el) => {
          const idx = parseInt(el.dataset.todoSnapshot!, 10);
          if (idx > maxIdx) maxIdx = idx;
        });
        setCurrentSnapshotIdx(maxIdx);
        return;
      }

      const viewportRect = viewport.getBoundingClientRect();
      const threshold = viewportRect.top + viewportRect.height * 0.5;

      // Range check: only show panel when midpoint is within the TodoWrite range
      const firstRect = todoEls[0].getBoundingClientRect();
      const lastRect = todoEls[todoEls.length - 1].getBoundingClientRect();
      if (threshold < firstRect.top || threshold > lastRect.bottom + 150) {
        setCurrentSnapshotIdx(-1);
        return;
      }

      // Find the latest snapshot whose element is above the viewport midpoint
      let latestIdx = -1;
      todoEls.forEach((el) => {
        const rect = el.getBoundingClientRect();
        if (rect.top <= threshold) {
          const idx = parseInt(el.dataset.todoSnapshot!, 10);
          if (idx > latestIdx) latestIdx = idx;
        }
      });

      setCurrentSnapshotIdx(latestIdx >= 0 ? latestIdx : -1);
    };

    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, [activeThread?.id]);

  // Scroll to bottom whenever the fingerprint changes (new messages, status changes).
  // Only scrolls if the user is already at the bottom (sticky behavior).
  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    if (!userHasScrolledUp.current) {
      viewport.scrollTop = viewport.scrollHeight;
    }
    // Hide scroll-to-bottom button if content doesn't overflow
    const hasOverflow = viewport.scrollHeight > viewport.clientHeight + 10;
    if (!hasOverflow) {
      setShowScrollDown(false);
    }
  }, [scrollFingerprint]);

  const scrollToBottom = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    userHasScrolledUp.current = false;
    setShowScrollDown(false);
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
  }, []);

  // Show new thread input when a project's "+" was clicked
  if (newThreadProjectId && !selectedThreadId) {
    return (
      <div className="flex-1 flex flex-col h-full min-w-0">
        <ProjectHeader />
        <NewThreadInput />
      </div>
    );
  }

  if (!selectedThreadId) {
    if (selectedProjectId) {
      return (
        <div className="flex-1 flex flex-col h-full min-w-0">
          <ProjectHeader />
          <NewThreadInput />
        </div>
      );
    }
    return (
      <div className="flex-1 flex flex-col h-full min-w-0">
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <p className="text-sm">{t('thread.selectOrCreate')}</p>
            <p className="text-xs mt-1">{t('thread.threadsRunParallel')}</p>
          </div>
        </div>
      </div>
    );
  }

  if (!activeThread) {
    return (
      <div className="flex-1 flex flex-col h-full min-w-0">
        {selectedProjectId && <ProjectHeader />}
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      </div>
    );
  }

  const handleSend = async (prompt: string, opts: { model: string; mode: string; fileReferences?: { path: string }[] }, images?: any[]) => {
    if (sending) return;
    setSending(true);

    useAppStore.getState().appendOptimisticMessage(
      activeThread.id,
      prompt,
      images,
      opts.model as any,
      opts.mode as any
    );

    const { allowedTools, disallowedTools } = deriveToolLists(useSettingsStore.getState().toolPermissions);
    const result = await api.sendMessage(activeThread.id, prompt, { model: opts.model || undefined, permissionMode: opts.mode || undefined, allowedTools, disallowedTools, fileReferences: opts.fileReferences }, images);
    if (result.isErr()) {
      console.error('Send failed:', result.error);
    }
    setSending(false);
  };

  const handleStop = async () => {
    const result = await api.stopThread(activeThread.id);
    if (result.isErr()) {
      console.error('Stop failed:', result.error);
    }
  };

  const handlePermissionApproval = async (toolName: string, approved: boolean) => {
    useAppStore.getState().appendOptimisticMessage(
      activeThread.id,
      approved ? `Approved: ${toolName}` : `Denied: ${toolName}`
    );
    const { allowedTools, disallowedTools } = deriveToolLists(useSettingsStore.getState().toolPermissions);
    const result = await api.approveTool(activeThread.id, toolName, approved, allowedTools, disallowedTools);
    if (result.isErr()) {
      console.error('Permission approval failed:', result.error);
    }
  };

  const isRunning = activeThread.status === 'running';
  const isIdle = activeThread.status === 'idle';

  // Idle thread (backlog or not): show prompt input to start (pre-loaded with initialPrompt if available)
  if (isIdle) {
    return (
      <div className="flex-1 flex flex-col h-full min-w-0">
        <ProjectHeader />
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <p className="text-sm font-medium mb-1">{activeThread.title}</p>
            <p className="text-xs">{t('thread.describeTask')}</p>
          </div>
        </div>
        <PromptInput
          onSubmit={handleSend}
          loading={sending}
          isNewThread
          projectId={activeThread.projectId}
          initialPrompt={activeThread.initialPrompt}
        />
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full min-w-0 relative">
      <ProjectHeader />

      {/* Floating TODO Panel */}
      <AnimatePresence>
        {currentSnapshot && !todoPanelDismissed && currentSnapshot.progress.completed < currentSnapshot.progress.total && (
          <TodoPanel
            todos={currentSnapshot.todos}
            progress={currentSnapshot.progress}
            onDismiss={() => setTodoPanelDismissed(true)}
          />
        )}
      </AnimatePresence>

      {/* Messages */}
      <ScrollArea className="flex-1 px-4" viewportRef={scrollViewportRef}>
        <div className="mx-auto max-w-3xl min-w-[320px] space-y-4 overflow-hidden py-4">
          {activeThread.initInfo && (
            <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{t('initInfo.model')}</span>
                <span className="font-mono">{activeThread.initInfo.model}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="font-medium">{t('initInfo.cwd')}</span>
                <span className="font-mono truncate">{activeThread.initInfo.cwd}</span>
              </div>
              <div className="flex items-start gap-2">
                <span className="font-medium shrink-0">{t('initInfo.tools')}</span>
                <span className="font-mono flex flex-wrap gap-1">
                  {activeThread.initInfo.tools.map((tool) => (
                    <span key={tool} className="bg-secondary px-1.5 py-0.5 rounded text-xs">
                      {tool}
                    </span>
                  ))}
                </span>
              </div>
            </div>
          )}

          {buildGroupedRenderItems(activeThread.messages ?? []).map((item) => {
              const renderToolItem = (ti: ToolItem) => {
                if (ti.type === 'toolcall') {
                  const tc = ti.tc;
                  return (
                    <motion.div
                      key={tc.id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.25, ease: 'easeOut' }}
                      className={(tc.name === 'AskUserQuestion' || tc.name === 'ExitPlanMode' || tc.name === 'TodoWrite') ? 'border border-border rounded-lg' : undefined}
                      {...(snapshotMap.has(tc.id) ? { 'data-todo-snapshot': snapshotMap.get(tc.id) } : {})}
                    >
                      <ToolCallCard
                        name={tc.name}
                        input={tc.input}
                        output={tc.output}
                        onRespond={(tc.name === 'AskUserQuestion' || tc.name === 'ExitPlanMode') ? (answer: string) => handleSend(answer, { model: '', mode: '' }) : undefined}
                      />
                    </motion.div>
                  );
                }
                if (ti.type === 'toolcall-group') {
                  const groupSnapshotIdx = ti.name === 'TodoWrite'
                    ? Math.max(...ti.calls.map((c: any) => snapshotMap.get(c.id) ?? -1))
                    : -1;
                  return (
                    <motion.div
                      key={ti.calls[0].id}
                      initial={{ opacity: 0, y: 6 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ duration: 0.25, ease: 'easeOut' }}
                      className={(ti.name === 'AskUserQuestion' || ti.name === 'ExitPlanMode' || ti.name === 'TodoWrite') ? 'border border-border rounded-lg' : undefined}
                      {...(groupSnapshotIdx >= 0 ? { 'data-todo-snapshot': groupSnapshotIdx } : {})}
                    >
                      <ToolCallGroup
                        name={ti.name}
                        calls={ti.calls}
                        onRespond={(ti.name === 'AskUserQuestion' || ti.name === 'ExitPlanMode')
                          ? (answer: string) => handleSend(answer, { model: '', mode: '' })
                          : undefined}
                      />
                    </motion.div>
                  );
                }
                return null;
              };

              if (item.type === 'message') {
                const msg = item.msg;
                return (
                  <motion.div
                    key={msg.id}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: 'easeOut' }}
                    className={cn(
                      'relative group text-sm max-w-[80%]',
                      msg.role === 'user'
                        ? 'ml-auto rounded-lg px-3 py-2 bg-muted text-foreground'
                        : 'text-foreground'
                    )}
                  >
                    {msg.role !== 'user' && (
                      <CopyButton content={msg.content} />
                    )}
                    {msg.images && msg.images.length > 0 && (() => {
                      const allImages = msg.images!.map((i: any, j: number) => ({
                        src: `data:${i.source.media_type};base64,${i.source.data}`,
                        alt: `Attachment ${j + 1}`,
                      }));
                      return (
                        <div className="flex flex-wrap gap-2 mb-2">
                          {msg.images!.map((img: any, idx: number) => (
                            <img
                              key={idx}
                              src={`data:${img.source.media_type};base64,${img.source.data}`}
                              alt={`Attachment ${idx + 1}`}
                              className="max-h-40 rounded border border-border cursor-pointer hover:opacity-80 transition-opacity"
                              onClick={() => openLightbox(allImages, idx)}
                            />
                          ))}
                        </div>
                      );
                    })()}
                    {msg.role === 'user' ? (
                      <>
                        <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed break-words overflow-x-auto max-h-80 overflow-y-auto">
                          {msg.content.trim()}
                        </pre>
                        {(msg.model || msg.permissionMode) && (
                          <div className="flex gap-1 mt-1.5">
                            {msg.model && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-medium bg-foreground/5 text-muted-foreground border-foreground/10">
                                {t(`thread.model.${msg.model}`)}
                              </Badge>
                            )}
                            {msg.permissionMode && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-medium bg-foreground/5 text-muted-foreground border-foreground/10">
                                {t(`prompt.${msg.permissionMode}`)}
                              </Badge>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="text-sm leading-relaxed break-words overflow-x-auto">
                        <MessageContent content={msg.content.trim()} />
                      </div>
                    )}
                  </motion.div>
                );
              }
              if (item.type === 'toolcall' || item.type === 'toolcall-group') {
                return renderToolItem(item);
              }
              if (item.type === 'toolcall-run') {
                return (
                  <div key={item.items[0].type === 'toolcall' ? item.items[0].tc.id : item.items[0].calls[0].id} className="space-y-1">
                    {item.items.map(renderToolItem)}
                  </div>
                );
              }
              return null;
            })}

          {isRunning && (
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="flex items-center gap-2.5 text-muted-foreground text-sm py-1"
            >
              <div className="flex items-center gap-1">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-[thinking_1.4s_ease-in-out_infinite]" />
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-[thinking_1.4s_ease-in-out_0.2s_infinite]" />
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-[thinking_1.4s_ease-in-out_0.4s_infinite]" />
              </div>
              <span className="text-xs">{t('thread.agentWorking')}</span>
            </motion.div>
          )}

          {activeThread.status === 'waiting' && activeThread.waitingReason === 'question' && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
              className="flex items-center gap-2 text-status-warning/80 text-xs"
            >
              <ShieldQuestion className="h-3.5 w-3.5 animate-pulse" />
              {t('thread.waitingForResponse')}
            </motion.div>
          )}

          {activeThread.status === 'waiting' && activeThread.waitingReason === 'permission' && activeThread.pendingPermission && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
            >
              <PermissionApprovalCard
                toolName={activeThread.pendingPermission.toolName}
                onApprove={() => handlePermissionApproval(activeThread.pendingPermission!.toolName, true)}
                onDeny={() => handlePermissionApproval(activeThread.pendingPermission!.toolName, false)}
              />
            </motion.div>
          )}

          {activeThread.status === 'waiting' && activeThread.waitingReason !== 'question' && activeThread.waitingReason !== 'permission' && activeThread.waitingReason !== 'plan' && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.25, ease: 'easeOut' }}
            >
              <WaitingActions
                onSend={(text) => handleSend(text, { model: activeThread.model, mode: activeThread.permissionMode })}
              />
            </motion.div>
          )}

          {activeThread.resultInfo && !isRunning && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              <AgentResultCard
                status={activeThread.resultInfo.status}
                cost={activeThread.resultInfo.cost}
                duration={activeThread.resultInfo.duration}
              />
            </motion.div>
          )}

          {activeThread.status === 'interrupted' && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              <AgentInterruptedCard
                onContinue={() => handleSend('Continue', { model: activeThread.model, mode: activeThread.permissionMode })}
              />
            </motion.div>
          )}

          {activeThread.status === 'stopped' && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
            >
              <AgentStoppedCard
                onContinue={() => handleSend('Continue', { model: activeThread.model, mode: activeThread.permissionMode })}
              />
            </motion.div>
          )}

        </div>
      </ScrollArea>

      {/* Scroll to bottom button */}
      {showScrollDown && (
        <div className="relative">
          <button
            onClick={scrollToBottom}
            className="absolute bottom-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1 rounded-full bg-secondary border border-border px-3 py-1.5 text-xs text-muted-foreground shadow-md hover:bg-muted transition-colors"
          >
            <ArrowDown className="h-3 w-3" />
            {t('thread.scrollToBottom', 'Scroll to bottom')}
          </button>
        </div>
      )}

      {/* Input */}
      <PromptInput
        onSubmit={handleSend}
        onStop={handleStop}
        loading={sending}
        running={isRunning}
        placeholder={t('thread.nextPrompt')}
      />

      {/* Image lightbox */}
      <ImageLightbox
        images={lightboxImages}
        initialIndex={lightboxIndex}
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
      />
    </div>
  );
}
