import { DEFAULT_FOLLOW_UP_MODE } from '@funny/shared/models';
import {
  Loader2,
  Clock,
  Copy,
  Check,
  Send,
  CheckCircle2,
  XCircle,
  ArrowDown,
  ShieldQuestion,
  FileText,
  FolderOpen,
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import {
  useState,
  useRef,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  memo,
  forwardRef,
  useImperativeHandle,
  startTransition,
  lazy,
  Suspense,
} from 'react';
import { flushSync } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Input } from '@/components/ui/input';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useCopyToClipboard } from '@/hooks/use-copy-to-clipboard';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { useTodoSnapshots } from '@/hooks/use-todo-panel';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { remarkPlugins, baseMarkdownComponents } from '@/lib/markdown-components';
import { parseReferencedFiles } from '@/lib/parse-referenced-files';
import {
  buildGroupedRenderItems,
  getItemKey,
  type ToolItem,
  type RenderItem,
} from '@/lib/render-items';
import { timeAgo, resolveModelLabel } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import {
  selectLastMessage,
  selectFirstMessage,
  useActiveMessages,
  useActiveThreadEvents,
  useActiveCompactionEvents,
} from '@/stores/thread-selectors';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

const tvLog = createClientLogger('ThreadView');

import { D4CAnimation } from './D4CAnimation';
import { FollowUpModeDialog } from './FollowUpModeDialog';
import { ImageLightbox } from './ImageLightbox';
import { PipelineProgressBanner } from './PipelineProgressBanner';
import { PromptInput } from './PromptInput';
import { AgentResultCard, AgentInterruptedCard, AgentStoppedCard } from './thread/AgentStatusCards';
import { CompactionEventCard } from './thread/CompactionEventCard';
import { GitEventCard } from './thread/GitEventCard';
import { NewThreadInput } from './thread/NewThreadInput';
import { ProjectHeader } from './thread/ProjectHeader';
import { PromptTimeline } from './thread/PromptTimeline';
import { WorkflowEventGroup } from './thread/WorkflowEventGroup';
import { ToolCallCard } from './ToolCallCard';
import { ToolCallGroup } from './ToolCallGroup';
import { WorktreeSetupProgress } from './WorktreeSetupProgress';

// Regex to match file paths like /foo/bar.ts, C:\foo\bar.ts, or file_path:line_number patterns
const FILE_PATH_RE = /(?:[A-Za-z]:[\\/]|\/)[^\s:*?"<>|,()]+(?::\d+)?/g;

import { toEditorUriWithLine, openFileInEditor } from '@/lib/editor-utils';
import { editorLabels } from '@/stores/settings-store';

// Prefetch react-markdown immediately at module load time.
// By the time ThreadView renders messages, the chunk is already downloaded.
const _markdownImport = import('react-markdown');

const LazyMarkdownRenderer = lazy(() =>
  _markdownImport.then(({ default: ReactMarkdown }) => {
    const markdownComponents = {
      ...baseMarkdownComponents,
      a: ({ href, children }: any) => {
        const text = String(children);
        const isWebUrl = href && /^https?:\/\//.test(href);
        const fileMatch = !isWebUrl && text.match(FILE_PATH_RE);
        if (fileMatch) {
          const editor = useSettingsStore.getState().defaultEditor;
          const uri = toEditorUriWithLine(fileMatch[0], editor);
          const label = editorLabels[editor];
          if (uri) {
            return (
              <a
                href={uri}
                className="text-primary hover:underline"
                title={`Open in ${label}: ${text}`}
              >
                {children}
              </a>
            );
          }
          return (
            <button
              onClick={() => openFileInEditor(fileMatch[0], editor)}
              className="inline cursor-pointer text-primary hover:underline"
              title={`Open in ${label}: ${text}`}
            >
              {children}
            </button>
          );
        }
        return (
          <a
            href={href}
            className="text-primary hover:underline"
            target="_blank"
            rel="noopener noreferrer"
          >
            {children}
          </a>
        );
      },
    };

    function MarkdownRenderer({ content }: { content: string }) {
      return (
        <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
          {content}
        </ReactMarkdown>
      );
    }
    return { default: MarkdownRenderer };
  }),
);

export const MessageContent = memo(function MessageContent({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none">
      <Suspense
        fallback={
          <div className="prose prose-sm max-w-none whitespace-pre-wrap text-sm">{content}</div>
        }
      >
        <LazyMarkdownRenderer content={content} />
      </Suspense>
    </div>
  );
});

export function CopyButton({ content }: { content: string }) {
  const [copied, copy] = useCopyToClipboard();

  return (
    <button
      onClick={() => copy(content)}
      className="msg-copy-btn shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover/msg:opacity-100"
      aria-label="Copy message"
      data-testid="message-copy"
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
    <div className="space-y-2.5 rounded-lg border border-status-warning/20 bg-status-warning/5 p-3">
      <div className="flex items-center gap-2 text-xs text-status-warning/80">
        <Clock className="h-3.5 w-3.5" />
        {t('thread.waitingForResponse')}
      </div>

      <div className="flex gap-2">
        <button
          data-testid="waiting-accept"
          onClick={() => onSend('Continue')}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          {t('thread.acceptContinue')}
        </button>
        <button
          data-testid="waiting-reject"
          onClick={() => onSend('No, do not proceed with that action.')}
          className="flex items-center gap-1.5 rounded-md border border-border bg-muted px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/30 hover:bg-destructive/10 hover:text-destructive"
        >
          <XCircle className="h-3.5 w-3.5" />
          {t('thread.reject')}
        </button>
      </div>

      <div className="flex gap-2">
        <Input
          ref={inputRef}
          data-testid="waiting-response-input"
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
          className="h-auto flex-1 py-1.5"
        />
        <button
          data-testid="waiting-send"
          onClick={handleSubmitInput}
          disabled={!input.trim()}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors',
            input.trim()
              ? 'bg-primary text-primary-foreground hover:bg-primary/90'
              : 'bg-muted text-muted-foreground cursor-not-allowed',
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
  onDeny,
}: {
  toolName: string;
  onApprove: () => void;
  onDeny: () => void;
}) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState<'approve' | 'deny' | null>(null);

  const handleApprove = () => {
    setLoading('approve');
    onApprove();
  };

  const handleDeny = () => {
    setLoading('deny');
    onDeny();
  };

  return (
    <div className="space-y-2.5 rounded-lg border border-status-warning/20 bg-status-warning/5 p-3">
      <div className="flex items-center gap-2 text-xs text-status-warning/80">
        <ShieldQuestion className="h-3.5 w-3.5" />
        {t('thread.permissionRequired')}
      </div>
      <p className="text-xs text-foreground">{t('thread.permissionMessage', { tool: toolName })}</p>
      <div className="flex gap-2">
        <button
          data-testid="permission-approve"
          onClick={handleApprove}
          disabled={!!loading}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors',
            loading && 'opacity-50 pointer-events-none',
          )}
        >
          {loading === 'approve' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <CheckCircle2 className="h-3.5 w-3.5" />
          )}
          {t('thread.approvePermission')}
        </button>
        <button
          data-testid="permission-deny"
          onClick={handleDeny}
          disabled={!!loading}
          className={cn(
            'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors',
            loading && 'opacity-50 pointer-events-none',
          )}
        >
          {loading === 'deny' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <XCircle className="h-3.5 w-3.5" />
          )}
          {t('thread.denyPermission')}
        </button>
      </div>
    </div>
  );
}

/** Group MCP tools by server prefix and show built-in tools individually */
function groupTools(tools: string[]) {
  const builtIn: string[] = [];
  const mcpGroups = new Map<string, string[]>();

  for (const tool of tools) {
    const match = tool.match(/^mcp__(.+?)__(.+)$/);
    if (match) {
      const serverName = match[1];
      if (!mcpGroups.has(serverName)) mcpGroups.set(serverName, []);
      mcpGroups.get(serverName)!.push(match[2]);
    } else {
      builtIn.push(tool);
    }
  }

  return { builtIn, mcpGroups };
}

function initInfoAreEqual(
  prev: { initInfo: { tools: string[]; cwd: string; model: string } },
  next: { initInfo: { tools: string[]; cwd: string; model: string } },
) {
  const a = prev.initInfo;
  const b = next.initInfo;
  if (a === b) return true;
  if (a.cwd !== b.cwd || a.model !== b.model) return false;
  if (a.tools === b.tools) return true;
  if (a.tools.length !== b.tools.length) return false;
  for (let i = 0; i < a.tools.length; i++) {
    if (a.tools[i] !== b.tools[i]) return false;
  }
  return true;
}

const InitInfoCard = memo(function InitInfoCard({
  initInfo,
}: {
  initInfo: { tools: string[]; cwd: string; model: string };
}) {
  const { t } = useTranslation();
  const { builtIn, mcpGroups } = useMemo(() => groupTools(initInfo.tools), [initInfo.tools]);

  return (
    <div className="space-y-1 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex items-center gap-2">
        <span className="font-medium">{t('initInfo.model')}</span>
        <span className="font-mono">{resolveModelLabel(initInfo.model, t)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-medium">{t('initInfo.cwd')}</span>
        <span className="truncate font-mono">{initInfo.cwd}</span>
      </div>
      <div className="flex items-start gap-2">
        <span className="shrink-0 font-medium">{t('initInfo.tools')}</span>
        <div className="flex flex-wrap items-start gap-1 font-mono">
          {builtIn.length === 0 && mcpGroups.size === 0 && (
            <span className="italic text-muted-foreground/60">{t('initInfo.providerManaged')}</span>
          )}
          {builtIn.map((tool) => (
            <span key={tool} className="rounded bg-secondary px-1.5 py-0.5 text-xs">
              {tool}
            </span>
          ))}
          {Array.from(mcpGroups.entries()).map(([serverName, toolNames]) => (
            <McpToolGroup key={serverName} serverName={serverName} toolNames={toolNames} />
          ))}
        </div>
      </div>
    </div>
  );
}, initInfoAreEqual);

function mcpToolGroupAreEqual(
  prev: { serverName: string; toolNames: string[] },
  next: { serverName: string; toolNames: string[] },
) {
  if (prev.serverName !== next.serverName) return false;
  if (prev.toolNames === next.toolNames) return true;
  if (prev.toolNames.length !== next.toolNames.length) return false;
  for (let i = 0; i < prev.toolNames.length; i++) {
    if (prev.toolNames[i] !== next.toolNames[i]) return false;
  }
  return true;
}

const McpToolGroup = memo(function McpToolGroup({
  serverName,
  toolNames,
}: {
  serverName: string;
  toolNames: string[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="inline-flex cursor-pointer items-center gap-0.5 rounded bg-primary/10 px-1.5 py-0.5 text-xs transition-colors hover:bg-primary/20">
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        {serverName} ({toolNames.length})
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-1 flex flex-wrap gap-1">
        {toolNames.map((name) => (
          <span key={name} className="rounded bg-secondary px-1.5 py-0.5 text-xs">
            {name}
          </span>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}, mcpToolGroupAreEqual);

const COLLAPSED_MAX_H = 48; // px – roughly 8 lines of text

function UserMessageContent({ content }: { content: string }) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);

  useLayoutEffect(() => {
    const el = preRef.current;
    if (el) {
      setIsOverflowing(el.scrollHeight > COLLAPSED_MAX_H);
    }
  }, [content]);

  return (
    <div className="relative">
      <pre
        ref={preRef}
        className={cn(
          'whitespace-pre-wrap font-mono text-xs leading-relaxed break-words overflow-x-auto',
          !expanded && isOverflowing && 'overflow-hidden',
          expanded && 'max-h-[50vh] overflow-y-auto',
        )}
        style={!expanded && isOverflowing ? { maxHeight: COLLAPSED_MAX_H } : undefined}
      >
        {content}
      </pre>
      {isOverflowing && !expanded && (
        <div className="pointer-events-none absolute bottom-6 left-0 right-0 h-10 bg-gradient-to-t from-foreground to-transparent" />
      )}
      {isOverflowing && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1 flex items-center gap-1 text-[11px] font-medium text-background transition-colors hover:text-background/80"
        >
          {expanded ? (
            <>
              <ChevronRight className="h-3 w-3 -rotate-90" />
              {t('thread.showLess', 'Show less')}
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
              {t('thread.showMore', 'Show more')}
            </>
          )}
        </button>
      )}
    </div>
  );
}

/* ── Windowed rendering constants ─────────────────────────────────── */
const INITIAL_WINDOW = 30;
const EXPAND_BATCH = 20;
const USER_PROMPT_TOP_OFFSET = 24;
const EMPTY_MESSAGES: any[] = [];

function estimateItemHeight(item: RenderItem): number {
  if (item.type === 'message') return item.msg.role === 'user' ? 80 : 120;
  if (item.type === 'toolcall') return 44;
  if (item.type === 'toolcall-group') return 44;
  if (item.type === 'toolcall-run') return 44 * item.items.length;
  if (item.type === 'thread-event') return 32;
  if (item.type === 'compaction-event') return 32;
  if (item.type === 'workflow-event-group') return 32;
  return 60;
}

interface MemoizedMessageListHandle {
  expandToItem: (id: string) => void;
}

/** Custom comparator for MemoizedMessageList — avoids re-renders when only
 *  unrelated activeThread properties changed (cost, contextUsage, etc.).
 *  NOTE: threadStatus IS included because tool cards like AskUserQuestion and
 *  ExitPlanMode conditionally render the "Respond" button based on whether the
 *  thread is in 'waiting' status. Without this, the button won't appear when
 *  agent:status arrives after the tool_call event. */
function messageListAreEqual(
  prev: {
    messages: any[];
    threadEvents?: any[];
    compactionEvents?: any[];
    threadId: string;
    threadStatus?: string;
    knownIds: Set<string>;
    prefersReducedMotion: boolean | null;
    snapshotMap: Map<string, number>;
    onSend: any;
    onOpenLightbox: any;
    scrollRef: any;
  },
  next: typeof prev,
) {
  return (
    prev.messages === next.messages &&
    prev.threadEvents === next.threadEvents &&
    prev.compactionEvents === next.compactionEvents &&
    prev.threadId === next.threadId &&
    prev.threadStatus === next.threadStatus &&
    prev.snapshotMap === next.snapshotMap &&
    prev.onSend === next.onSend &&
    prev.onOpenLightbox === next.onOpenLightbox &&
    prev.scrollRef === next.scrollRef
  );
}

/** Memoized message list with windowed rendering — only mounts the last
 *  INITIAL_WINDOW items on first render, expanding progressively on scroll-up.
 *  Items are never un-mounted; contentVisibility:'auto' handles paint cost. */
const MemoizedMessageList = memo(
  forwardRef<
    MemoizedMessageListHandle,
    {
      messages: any[];
      threadEvents?: import('@funny/shared').ThreadEvent[];
      compactionEvents?: import('@/stores/thread-store').CompactionEvent[];
      threadId: string;
      threadStatus?: string;
      knownIds: Set<string>;
      prefersReducedMotion: boolean | null;
      snapshotMap: Map<string, number>;
      onSend: (prompt: string, opts: { model: string; mode: string }) => void;
      onOpenLightbox: (images: { src: string; alt: string }[], index: number) => void;
      scrollRef: React.RefObject<HTMLElement | null>;
    }
  >(function MemoizedMessageList(
    {
      messages,
      threadEvents,
      compactionEvents,
      threadId,
      threadStatus,
      knownIds: _knownIds,
      prefersReducedMotion: _prefersReducedMotion,
      snapshotMap,
      onSend,
      onOpenLightbox,
      scrollRef,
    },
    ref,
  ) {
    const { t } = useTranslation();

    const groupedItems = useMemo(
      () => buildGroupedRenderItems(messages, threadEvents, compactionEvents),
      [messages, threadEvents, compactionEvents],
    );

    /* ── Windowed rendering ──────────────────────────────────────────── */
    const [renderCount, setRenderCount] = useState(INITIAL_WINDOW);

    // Reset render window when switching threads (synchronous state reset
    // during render — standard React derived-state-from-props pattern).
    const prevThreadIdRef = useRef(threadId);
    if (prevThreadIdRef.current !== threadId) {
      prevThreadIdRef.current = threadId;
      setRenderCount(INITIAL_WINDOW);
    }

    const windowStart = Math.max(0, groupedItems.length - renderCount);
    const visibleItems = groupedItems.slice(windowStart);
    const hasHiddenItems = windowStart > 0;

    // ID → index map for expandToItem (scroll-to-message support)
    const itemIndexMap = useMemo(() => {
      const map = new Map<string, number>();
      groupedItems.forEach((item, index) => {
        if (item.type === 'message') map.set(item.msg.id, index);
        else if (item.type === 'toolcall') map.set(item.tc.id, index);
        else if (item.type === 'toolcall-group')
          item.calls.forEach((c: any) => map.set(c.id, index));
        else if (item.type === 'toolcall-run') {
          for (const ti of item.items) {
            if (ti.type === 'toolcall') map.set(ti.tc.id, index);
            else if (ti.type === 'toolcall-group')
              ti.calls.forEach((c: any) => map.set(c.id, index));
          }
        } else if (item.type === 'thread-event') map.set(item.event.id, index);
      });
      return map;
    }, [groupedItems]);

    // Expose expandToItem so ThreadView can expand the window before scrolling
    useImperativeHandle(
      ref,
      () => ({
        expandToItem: (id: string) => {
          const index = itemIndexMap.get(id);
          if (index !== undefined) {
            const needed = groupedItems.length - index + 5;
            if (needed > renderCount) {
              flushSync(() => setRenderCount(Math.min(groupedItems.length, needed)));
            }
          }
        },
      }),
      [itemIndexMap, renderCount, groupedItems.length],
    );

    // Estimated spacer height for items above the render window
    const spacerHeight = useMemo(() => {
      let h = 0;
      for (let i = 0; i < windowStart; i++) {
        h += estimateItemHeight(groupedItems[i]);
        if (i < windowStart - 1) h += 16; // space-y-4 gap
      }
      return h;
    }, [groupedItems, windowStart]);

    // Refs so the scroll listener always reads fresh values without re-attaching
    const spacerHeightRef = useRef(spacerHeight);
    spacerHeightRef.current = spacerHeight;
    const windowStartRef = useRef(windowStart);
    windowStartRef.current = windowStart;
    const groupedLenRef = useRef(groupedItems.length);
    groupedLenRef.current = groupedItems.length;

    // Scroll-based window expansion — fires on every scroll event so fast
    // mouse-wheel scrolling is always caught (IntersectionObserver can miss it).
    useEffect(() => {
      const scrollEl = scrollRef.current;
      if (!scrollEl) return;

      const onScroll = () => {
        if (windowStartRef.current <= 0) return;
        if (scrollEl.scrollTop < spacerHeightRef.current + 600) {
          setRenderCount((prev) => Math.min(groupedLenRef.current, prev + EXPAND_BATCH));
        }
      };

      scrollEl.addEventListener('scroll', onScroll, { passive: true });
      return () => scrollEl.removeEventListener('scroll', onScroll);
    }, [scrollRef]);

    // After each expansion, check if the user has already scrolled past the
    // newly rendered items (fast-scroll catch-up).  Runs once per frame via
    // rAF and chains until the spacer is far enough from the viewport.
    useEffect(() => {
      if (windowStart <= 0) return;
      const scrollEl = scrollRef.current;
      if (!scrollEl) return;

      const rafId = requestAnimationFrame(() => {
        if (scrollEl.scrollTop < spacerHeightRef.current + 600) {
          setRenderCount((prev) => Math.min(groupedLenRef.current, prev + EXPAND_BATCH));
        }
      });
      return () => cancelAnimationFrame(rafId);
    }, [windowStart, scrollRef]);

    const renderToolItem = useCallback(
      (ti: ToolItem) => {
        if (ti.type === 'toolcall') {
          const tc = ti.tc;
          return (
            <div
              key={tc.id}
              data-tool-call-id={tc.id}
              {...(snapshotMap.has(tc.id) ? { 'data-todo-snapshot': snapshotMap.get(tc.id) } : {})}
            >
              <ToolCallCard
                name={tc.name}
                input={tc.input}
                output={tc.output}
                planText={tc._planText}
                onRespond={
                  (tc.name === 'AskUserQuestion' || tc.name === 'ExitPlanMode') &&
                  threadStatus === 'waiting'
                    ? (answer: string) => {
                        tvLog.info('onRespond (single)', {
                          toolName: tc.name,
                          toolCallId: tc.id,
                          answerPreview: answer.slice(0, 120),
                        });
                        useThreadStore
                          .getState()
                          .handleWSToolOutput(threadId, { toolCallId: tc.id, output: answer });
                        // Persist the formatted answer directly on the tool call so it
                        // survives page refreshes (sendMessage also attempts this but
                        // uses the raw prompt text which may differ from the formatted answer).
                        api.updateToolCallOutput(threadId, tc.id, answer);
                        onSend(answer, { model: '', mode: '' });
                      }
                    : undefined
                }
              />
            </div>
          );
        }
        if (ti.type === 'toolcall-group') {
          const groupSnapshotIdx =
            ti.name === 'TodoWrite'
              ? Math.max(...ti.calls.map((c: any) => snapshotMap.get(c.id) ?? -1))
              : -1;
          return (
            <div
              key={ti.calls[0].id}
              data-tool-call-id={ti.calls[0].id}
              {...(groupSnapshotIdx >= 0 ? { 'data-todo-snapshot': groupSnapshotIdx } : {})}
            >
              <ToolCallGroup
                name={ti.name}
                calls={ti.calls}
                onRespond={
                  (ti.name === 'AskUserQuestion' || ti.name === 'ExitPlanMode') &&
                  threadStatus === 'waiting'
                    ? (answer: string) => {
                        tvLog.info('onRespond (group)', {
                          toolName: ti.name,
                          callCount: String(ti.calls.length),
                          answerPreview: answer.slice(0, 120),
                        });
                        for (const call of ti.calls) {
                          if (!call.output) {
                            useThreadStore.getState().handleWSToolOutput(threadId, {
                              toolCallId: call.id,
                              output: answer,
                            });
                            api.updateToolCallOutput(threadId, call.id, answer);
                          }
                        }
                        onSend(answer, { model: '', mode: '' });
                      }
                    : undefined
                }
              />
            </div>
          );
        }
        return null;
      },
      [snapshotMap, threadId, threadStatus, onSend],
    );

    // Group items into sections: each section starts with a user message
    // and contains all following items until the next user message.
    // Items before the first user message go into a "preamble" section (no sticky header).
    type MessageItem = Extract<RenderItem, { type: 'message' }>;
    const sections = useMemo(() => {
      const result: { userItem: MessageItem | null; items: RenderItem[] }[] = [];
      let current: { userItem: MessageItem | null; items: RenderItem[] } = {
        userItem: null,
        items: [],
      };

      for (const item of visibleItems) {
        if (item.type === 'message' && item.msg.role === 'user') {
          // Push previous section if it has content
          if (current.userItem || current.items.length > 0) {
            result.push(current);
          }
          current = { userItem: item as MessageItem, items: [] };
        } else {
          current.items.push(item);
        }
      }
      // Push the last section
      if (current.userItem || current.items.length > 0) {
        result.push(current);
      }
      return result;
    }, [visibleItems]);

    const renderNonUserItem = useCallback(
      (item: RenderItem) => {
        const key = getItemKey(item);

        if (item.type === 'message') {
          const msg = item.msg;
          return (
            <div
              key={key}
              style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 60px' }}
              className="group/msg relative w-full text-sm text-foreground"
            >
              <div className="break-words text-sm leading-relaxed">
                <div className="flex items-start gap-2">
                  {msg.author && (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Avatar className="mt-0.5">
                          <AvatarFallback className="bg-primary/10 text-xs font-medium text-primary">
                            {msg.author.slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                      </TooltipTrigger>
                      <TooltipContent side="top">{msg.author}</TooltipContent>
                    </Tooltip>
                  )}
                  <div className="min-w-0 flex-1">
                    <MessageContent content={msg.content.trim()} />
                  </div>
                  <CopyButton content={msg.content} />
                </div>
                <div className="mt-1">
                  <span className="select-none text-xs text-muted-foreground/60">
                    {timeAgo(msg.timestamp, t)}
                  </span>
                </div>
              </div>
            </div>
          );
        }

        if (item.type === 'toolcall' || item.type === 'toolcall-group') {
          // Don't use contentVisibility:auto for interactive cards (AskUserQuestion, ExitPlanMode)
          // — the browser may skip rendering them when off-screen, preventing user interaction.
          const toolName = item.type === 'toolcall' ? item.tc.name : item.name;
          const isInteractive = toolName === 'AskUserQuestion' || toolName === 'ExitPlanMode';
          return (
            <div
              key={key}
              style={
                isInteractive
                  ? undefined
                  : { contentVisibility: 'auto', containIntrinsicSize: 'auto 40px' }
              }
            >
              {renderToolItem(item)}
            </div>
          );
        }

        if (item.type === 'toolcall-run') {
          return (
            <div key={key} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 40px' }}>
              <div className="space-y-1">{item.items.map(renderToolItem)}</div>
            </div>
          );
        }

        if (item.type === 'workflow-event-group') {
          return (
            <div key={key} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 32px' }}>
              <WorkflowEventGroup events={item.events} />
            </div>
          );
        }

        if (item.type === 'thread-event') {
          return (
            <div key={key} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 32px' }}>
              <GitEventCard event={item.event} />
            </div>
          );
        }

        if (item.type === 'compaction-event') {
          return (
            <div key={key} style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 32px' }}>
              <CompactionEventCard event={item.event} />
            </div>
          );
        }

        return null;
      },
      [renderToolItem, t],
    );

    const renderUserMessage = useCallback(
      (item: Extract<RenderItem, { type: 'message' }>) => {
        const msg = item.msg;
        return (
          <div className="sticky top-0 z-20 pb-3 pt-3">
            <div
              className={cn(
                'relative group text-sm',
                'w-full rounded-lg px-3 py-2 bg-foreground text-background cursor-pointer',
                'shadow-md',
              )}
              data-user-msg={msg.id}
              onClick={() => {
                const section = scrollRef.current?.querySelector(
                  `[data-section-msg-id="${msg.id}"]`,
                );
                if (section) {
                  section.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }
              }}
            >
              {msg.images &&
                msg.images.length > 0 &&
                (() => {
                  const allImages = msg.images!.map((i: any, j: number) => ({
                    src: `data:${i.source.media_type};base64,${i.source.data}`,
                    alt: `Attachment ${j + 1}`,
                  }));
                  return (
                    <div className="mb-2 flex flex-wrap gap-2">
                      {msg.images!.map((img: any, idx: number) => (
                        <img
                          key={`attachment-${idx}`}
                          src={`data:${img.source.media_type};base64,${img.source.data}`}
                          alt={`Attachment ${idx + 1}`}
                          width={160}
                          height={160}
                          loading="lazy"
                          className="max-h-40 cursor-pointer rounded border border-border transition-opacity hover:opacity-80"
                          onClick={() => onOpenLightbox(allImages, idx)}
                        />
                      ))}
                    </div>
                  );
                })()}
              {(() => {
                const { files, cleanContent } = parseReferencedFiles(msg.content);
                return (
                  <>
                    {files.length > 0 && (
                      <div className="mb-1.5 flex flex-wrap gap-1">
                        {files.map((fileItem) => (
                          <span
                            key={`${fileItem.type}:${fileItem.path}`}
                            className="inline-flex items-center gap-1 rounded bg-background/20 px-1.5 py-0.5 font-mono text-xs text-background/70"
                            title={fileItem.path}
                          >
                            {fileItem.type === 'folder' ? (
                              <FolderOpen className="h-3 w-3 shrink-0" />
                            ) : (
                              <FileText className="h-3 w-3 shrink-0" />
                            )}
                            {fileItem.path.split('/').pop()}
                          </span>
                        ))}
                      </div>
                    )}
                    <UserMessageContent content={cleanContent.trim()} />
                    <div className="mt-1.5 flex items-center justify-between">
                      <div className="flex gap-1">
                        {msg.model && (
                          <Badge
                            variant="outline"
                            className="h-4 border-background/20 bg-background/10 px-1.5 py-0 text-[10px] font-medium text-background/60"
                          >
                            {resolveModelLabel(msg.model, t)}
                          </Badge>
                        )}
                        {msg.permissionMode && (
                          <Badge
                            variant="outline"
                            className="h-4 border-background/20 bg-background/10 px-1.5 py-0 text-[10px] font-medium text-background/60"
                          >
                            {t(`prompt.${msg.permissionMode}`)}
                          </Badge>
                        )}
                      </div>
                      {msg.timestamp && (
                        <span className="text-[10px] text-background/50">
                          {timeAgo(msg.timestamp, t)}
                        </span>
                      )}
                    </div>
                  </>
                );
              })()}
            </div>
          </div>
        );
      },
      [onOpenLightbox, scrollRef, t],
    );

    return (
      <>
        {hasHiddenItems && <div style={{ height: spacerHeight }} aria-hidden="true" />}
        {sections.map((section, sIdx) => {
          const sectionKey = section.userItem ? getItemKey(section.userItem) : `preamble-${sIdx}`;

          // Preamble section (items before first user message) — no sticky header
          if (!section.userItem) {
            return (
              <div key={sectionKey} className="space-y-4">
                {section.items.map(renderNonUserItem)}
              </div>
            );
          }

          return (
            <div key={sectionKey} data-section-msg-id={section.userItem.msg.id}>
              {renderUserMessage(section.userItem)}
              {section.items.length > 0 && (
                <div className="space-y-4">{section.items.map(renderNonUserItem)}</div>
              )}
            </div>
          );
        })}
      </>
    );
  }),
  messageListAreEqual,
);

export function ThreadView() {
  const { t } = useTranslation();
  useMinuteTick(); // re-render every 60s so timeAgo stays fresh
  const activeThread = useThreadStore((s) => s.activeThread);
  // Granular selectors: these return the same reference when only status/cost
  // changed, preventing MemoizedMessageList from re-rendering on status-only updates.
  const stableMessages = useActiveMessages();
  const stableThreadEvents = useActiveThreadEvents();
  const stableCompactionEvents = useActiveCompactionEvents();
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const newThreadProjectId = useUIStore((s) => s.newThreadProjectId);
  const timelineVisible = useUIStore((s) => s.timelineVisible);
  const hasProjects = useProjectStore((s) => s.projects.length > 0);
  const loadOlderMessages = useThreadStore((s) => s.loadOlderMessages);
  const hasMore = activeThread?.hasMore ?? false;
  const loadingMore = activeThread?.loadingMore ?? false;
  const [sending, setSending] = useState(false);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const userHasScrolledUp = useRef(false);
  const smoothScrollPending = useRef(false);
  // Guard flag: while a programmatic scroll-to-bottom is in progress,
  // the scroll handler must NOT flip userHasScrolledUp back to true.
  const scrollingToBottomRef = useRef(false);
  // Tracks the thread ID for which we've already forced a scroll-to-bottom.
  // Used by the fingerprint effect to force one extra scroll after the thread
  // switch effect, catching content that renders after the initial commit.
  const scrolledThreadRef = useRef<string | null>(null);
  const prevOldestIdRef = useRef<string | null>(null);
  const prevScrollHeightRef = useRef(0);
  const scrollDownRef = useRef<HTMLDivElement>(null);
  const inputDockRef = useRef<HTMLDivElement>(null);
  const contentStackRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<MemoizedMessageListHandle>(null);
  const pinnedPromptIdRef = useRef<string | null>(null);
  const [visibleMessageId, setVisibleMessageId] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxImages, setLightboxImages] = useState<{ src: string; alt: string }[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [promptPinSpacerHeight, setPromptPinSpacerHeight] = useState(0);
  // Ref mirror so pinUserMessageToTop can read the current value without
  // being a dependency of useCallback (avoids cascading layout effects).
  const promptPinSpacerHeightRef = useRef(0);
  promptPinSpacerHeightRef.current = promptPinSpacerHeight;
  const prefersReducedMotion = useReducedMotion();

  // "Ask" follow-up mode: dialog state for when user sends while agent is running
  const [followUpDialogOpen, setFollowUpDialogOpen] = useState(false);
  const pendingSendRef = useRef<{
    prompt: string;
    opts: {
      provider?: string;
      model?: string;
      permissionMode?: string;
      allowedTools?: string[];
      disallowedTools?: string[];
      fileReferences?: { path: string }[];
      baseBranch?: string;
    };
    images?: any[];
  } | null>(null);
  const setPromptRef = useRef<((text: string) => void) | null>(null);

  // Track which message/tool-call IDs existed when the thread was loaded.
  // Messages in this set skip entrance animations to prevent CLS.
  const knownIdsRef = useRef<Set<string>>(new Set());
  const prevThreadIdRef = useRef<string | null>(null);

  // Populate knownIdsRef synchronously during render (not in useEffect) so the
  // very first render already knows which IDs to skip animations for.
  if (activeThread?.id !== prevThreadIdRef.current) {
    prevThreadIdRef.current = activeThread?.id ?? null;
    const ids = new Set<string>();
    if (activeThread?.messages) {
      for (const m of activeThread.messages) {
        ids.add(m.id);
        if (m.toolCalls) {
          for (const tc of m.toolCalls) ids.add(tc.id);
        }
      }
    }
    knownIdsRef.current = ids;
  }

  const snapshots = useTodoSnapshots();

  // Map tool call IDs to snapshot indices for data-attribute lookup.
  // Use a ref to keep the same Map reference when the content hasn't changed,
  // preventing MemoizedMessageList from re-rendering on every WS update.
  const snapshotMapRef = useRef(new Map<string, number>());
  const snapshotMap = useMemo(() => {
    const next = new Map<string, number>();
    snapshots.forEach((s, i) => next.set(s.toolCallId, i));
    const prev = snapshotMapRef.current;
    if (prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v)) {
      return prev; // content unchanged — reuse old reference
    }
    snapshotMapRef.current = next;
    return next;
  }, [snapshots]);

  // Helper: schedule a non-critical state update during idle time
  const scheduleIdle = useCallback((fn: () => void) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(fn);
    else setTimeout(fn, 0);
  }, []);

  const pinUserMessageToTop = useCallback(
    (messageId?: string | null, smooth = false) => {
      const viewport = scrollViewportRef.current;
      if (!viewport) return;

      const targetId = messageId ?? lastUserMsgIdRef.current;
      if (!targetId) {
        pinnedPromptIdRef.current = null;
        if (promptPinSpacerHeightRef.current !== 0) {
          setPromptPinSpacerHeight(0);
        }
        return;
      }

      const target = viewport.querySelector<HTMLElement>(`[data-user-msg="${targetId}"]`);
      if (!target) return;

      pinnedPromptIdRef.current = targetId;
      const currentSpacerHeight = promptPinSpacerHeightRef.current;
      const inputDockHeight = inputDockRef.current?.offsetHeight ?? 0;
      const contentStack = contentStackRef.current;
      const targetRect = target.getBoundingClientRect();
      const contentRect = contentStack?.getBoundingClientRect();
      const renderedContentBelow = Math.max(
        0,
        (contentRect?.bottom ?? targetRect.bottom) - targetRect.bottom - currentSpacerHeight,
      );
      const availableBelow = Math.max(
        0,
        viewport.clientHeight - inputDockHeight - target.offsetHeight - USER_PROMPT_TOP_OFFSET,
      );
      const nextSpacerHeight = Math.max(0, availableBelow - renderedContentBelow);
      if (Math.abs(currentSpacerHeight - nextSpacerHeight) > 1) {
        flushSync(() => {
          setPromptPinSpacerHeight(nextSpacerHeight);
        });
      }

      const scrollPos =
        viewport.scrollTop +
        target.getBoundingClientRect().top -
        viewport.getBoundingClientRect().top -
        USER_PROMPT_TOP_OFFSET;
      const finalPos = Math.max(0, scrollPos);
      if (smooth) {
        viewport.scrollTo({ top: finalPos, behavior: 'smooth' });
      } else {
        viewport.scrollTop = finalPos;
      }
      userHasScrolledUp.current = true;
      // Re-evaluate scroll-to-bottom visibility after pinning
      if (scrollDownRef.current) {
        const isBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= 80;
        const hasOverflow = viewport.scrollHeight > viewport.clientHeight + 10;
        scrollDownRef.current.style.display = hasOverflow && !isBottom ? '' : 'none';
      }
      scheduleIdle(() => setVisibleMessageId(targetId));
    },
    [scheduleIdle],
  );

  // When opening or switching threads, keep the latest user prompt pinned near
  // the top instead of jumping to the bottom.
  useLayoutEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport || !activeThread) return;

    // Reset pagination refs, then pin the latest user prompt.
    userHasScrolledUp.current = true;
    prevOldestIdRef.current = null;
    prevScrollHeightRef.current = 0;
    pinnedPromptIdRef.current = null;
    scrolledThreadRef.current = null;
    const rafId = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        pinUserMessageToTop();
      });
    });
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentionally only reset on thread ID change, not on every activeThread reference update
  }, [activeThread?.id, pinUserMessageToTop]);

  const openLightbox = useCallback((images: { src: string; alt: string }[], index: number) => {
    setLightboxImages(images);
    setLightboxIndex(index);
    setLightboxOpen(true);
  }, []);

  const lastMessage = selectLastMessage(activeThread);

  // Count user messages to detect when the *user* sends a new prompt
  // (as opposed to agent streaming updates which shouldn't reposition scroll).
  const userMessageCount = useMemo(
    () => activeThread?.messages?.filter((m: any) => m.role === 'user').length ?? 0,
    [activeThread?.messages],
  );
  const prevUserMessageCountRef = useRef(userMessageCount);
  const prevWaitingReasonRef = useRef(activeThread?.waitingReason);

  const scrollFingerprint = [
    activeThread?.messages?.length,
    lastMessage?.content?.length,
    lastMessage?.toolCalls?.length,
    activeThread?.status,
    activeThread?.waitingReason ?? '',
    !!activeThread?.initInfo, // trigger scroll-to-bottom when initInfo arrives (prevents CLS)
  ].join(':');

  // Ref tracking the last user message ID (avoids DOM queries in scroll handler)
  const lastUserMsgIdRef = useRef<string | null>(null);
  useEffect(() => {
    const last = activeThread?.messages
      ?.filter((m: any) => m.role === 'user' && m.content?.trim())
      .at(-1);
    lastUserMsgIdRef.current = last?.id ?? null;
  }, [activeThread?.messages]);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport;
      const hasOverflow = scrollHeight > clientHeight + 10;
      const promptPinned = promptPinSpacerHeightRef.current > 0;
      const isAtBottom = scrollHeight - scrollTop - clientHeight <= 80;

      // While a programmatic scroll-to-bottom is in progress, don't mark
      // the user as scrolled-up — intermediate positions during the animation
      // would otherwise set the flag and break sticky-bottom.
      if (!scrollingToBottomRef.current) {
        userHasScrolledUp.current = promptPinned || !isAtBottom;
      } else if (isAtBottom) {
        // Programmatic scroll reached the bottom — clear the guard
        scrollingToBottomRef.current = false;
        userHasScrolledUp.current = false;
      }

      // Update scroll-to-bottom button visibility via DOM (fast path, no React state)
      const shouldShow = hasOverflow && !isAtBottom && !scrollingToBottomRef.current;
      if (scrollDownRef.current) {
        scrollDownRef.current.style.display = shouldShow ? '' : 'none';
      }

      // Load older messages when scrolled near the top
      if (scrollTop < 200 && hasMore && !loadingMore) {
        loadOlderMessages();
      }

      // At-bottom: sync visible message ID to last user message (no DOM queries)
      if (isAtBottom && lastUserMsgIdRef.current) {
        scheduleIdle(() => setVisibleMessageId(lastUserMsgIdRef.current));
      }
    };

    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, [activeThread?.id, hasMore, loadingMore, loadOlderMessages, scheduleIdle]);

  // IntersectionObserver for visible user message tracking (replaces getBoundingClientRect loop).
  // Detects which user message section contains the ~40% viewport line.
  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport || !activeThread?.id) return;

    const io = new IntersectionObserver(
      (entries) => {
        // When scrolled to bottom, the scroll handler sets visibleMessageId — skip here.
        if (!userHasScrolledUp.current) return;
        for (const entry of entries) {
          if (entry.isIntersecting) {
            const id = (entry.target as HTMLElement).dataset.userMsg;
            if (id) scheduleIdle(() => setVisibleMessageId(id));
          }
        }
      },
      { root: viewport, rootMargin: '-35% 0px -55% 0px', threshold: [0] },
    );

    const observeAll = () => {
      io.disconnect();
      viewport.querySelectorAll<HTMLElement>('[data-user-msg]').forEach((el) => io.observe(el));
    };
    observeAll();

    // Re-observe when DOM structure changes (new messages, window expansion)
    let debounceTimer: ReturnType<typeof setTimeout>;
    const mo = new MutationObserver(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(observeAll, 200);
    });
    mo.observe(viewport, { childList: true, subtree: true });

    return () => {
      io.disconnect();
      mo.disconnect();
      clearTimeout(debounceTimer);
    };
  }, [activeThread?.id, scheduleIdle]);

  // Only re-pin the user prompt when a *new user message* appears (the user
  // sent a prompt) or on thread switch.  Agent-side updates (tool calls,
  // streaming content, status changes) should NOT reposition the scroll when
  // the user is freely scrolling through the conversation.
  useLayoutEffect(() => {
    const isNewThread = activeThread?.id != null && scrolledThreadRef.current !== activeThread.id;
    if (isNewThread && activeThread?.id) {
      scrolledThreadRef.current = activeThread.id;
    }
    smoothScrollPending.current = false;

    const hasNewUserMessage = userMessageCount > prevUserMessageCountRef.current;
    prevUserMessageCountRef.current = userMessageCount;

    // Detect when waitingReason transitions to 'question' or 'permission'
    // — the agent is asking something and the user needs to see the widget.
    const curWaiting = activeThread?.waitingReason;
    const prevWaiting = prevWaitingReasonRef.current;
    prevWaitingReasonRef.current = curWaiting;
    const needsAttention =
      (curWaiting === 'question' || curWaiting === 'permission') && curWaiting !== prevWaiting;

    // Re-pin only when switching threads or when the user sent a new prompt.
    // Otherwise leave scroll position alone so the user can browse freely.
    if (isNewThread || hasNewUserMessage) {
      requestAnimationFrame(() => {
        pinUserMessageToTop(null, hasNewUserMessage && !isNewThread);
      });
    } else if (needsAttention) {
      // Auto-scroll to bottom to reveal AskUserQuestion / permission card
      const viewport = scrollViewportRef.current;
      if (viewport) {
        userHasScrolledUp.current = false;
        requestAnimationFrame(() => {
          viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
        });
      }
    } else if (!userHasScrolledUp.current) {
      // Sticky bottom: if the user is at the bottom and new agent content arrives,
      // keep them at the bottom so they can follow along in real time.
      const viewport = scrollViewportRef.current;
      if (viewport) {
        requestAnimationFrame(() => {
          viewport.scrollTop = viewport.scrollHeight;
          // Second frame: catch layout shifts from windowed-rendering expansion
          // triggered by the first scroll (spacer recalc, new items rendered).
          requestAnimationFrame(() => {
            if (!userHasScrolledUp.current) {
              viewport.scrollTop = viewport.scrollHeight;
            }
          });
        });
      }
    }
  }, [
    activeThread?.id,
    activeThread?.waitingReason,
    pinUserMessageToTop,
    scrollFingerprint,
    userMessageCount,
  ]);

  // Preserve scroll position when older messages are prepended
  const firstMessageId = selectFirstMessage(activeThread)?.id ?? null;
  useLayoutEffect(() => {
    const oldestId = firstMessageId;
    const viewport = scrollViewportRef.current;

    if (viewport && prevOldestIdRef.current && oldestId && prevOldestIdRef.current !== oldestId) {
      const addedHeight = viewport.scrollHeight - prevScrollHeightRef.current;
      viewport.scrollTop += addedHeight;
    }

    prevOldestIdRef.current = oldestId;
    if (viewport) {
      prevScrollHeightRef.current = viewport.scrollHeight;
    }
  }, [firstMessageId]);

  const scrollToBottom = useCallback(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    // Reset prompt-pin spacer so content isn't artificially padded
    if (promptPinSpacerHeightRef.current !== 0) {
      pinnedPromptIdRef.current = null;
      flushSync(() => setPromptPinSpacerHeight(0));
    }
    // Set the guard flag so intermediate scroll events don't flip
    // userHasScrolledUp back to true during the animation.
    scrollingToBottomRef.current = true;
    userHasScrolledUp.current = false;
    if (scrollDownRef.current) scrollDownRef.current.style.display = 'none';

    // Use instant scroll to avoid stale-target issues: smooth scrolling
    // animates toward the scrollHeight captured at call time, but windowed
    // rendering may change scrollHeight mid-animation (spacer recalc,
    // render-window expansion), causing the scroll to stop short.
    viewport.scrollTop = viewport.scrollHeight;

    // After the DOM settles (layout may shift due to render-window
    // expansion triggered by the scroll), re-snap to the true bottom.
    // Two rAF frames ensures React has committed any state changes.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!scrollingToBottomRef.current) return;
        viewport.scrollTop = viewport.scrollHeight;
        scrollingToBottomRef.current = false;
      });
    });
  }, []);

  // Stable ref to avoid recreating handleSend on every render.
  // This prevents PromptInput and MemoizedMessageList from re-rendering
  // due to the onSubmit/onSend prop reference changing.
  // NOTE: These hooks MUST be before any early returns to satisfy the Rules of Hooks.
  const activeThreadRef = useRef(activeThread);
  activeThreadRef.current = activeThread;
  const sendingRef = useRef(sending);
  sendingRef.current = sending;

  const handleSend = useCallback(
    async (
      prompt: string,
      opts: {
        provider?: string;
        model: string;
        mode: string;
        fileReferences?: { path: string; type?: 'file' | 'folder' }[];
        baseBranch?: string;
      },
      images?: any[],
    ) => {
      if (sendingRef.current) {
        tvLog.warn('handleSend: blocked by sendingRef (duplicate send attempt)', {
          promptPreview: prompt.slice(0, 80),
        });
        return;
      }
      const thread = activeThreadRef.current;
      if (!thread) return;
      tvLog.info('handleSend', {
        threadId: thread.id,
        threadStatus: thread.status,
        promptPreview: prompt.slice(0, 120),
      });

      // Treat thread as running if agent is active OR queued messages are pending
      // (queue drains immediately on completion — there's a brief gap where status
      // is 'completed' but the next queued agent hasn't started yet)
      const queuedCount = (thread as any).queuedCount ?? 0;
      const threadIsRunning = thread.status === 'running' || queuedCount > 0;
      const currentProject = useProjectStore
        .getState()
        .projects.find((p) => p.id === thread.projectId);
      const followUpMode = currentProject?.followUpMode || DEFAULT_FOLLOW_UP_MODE;

      // "Ask" mode: show dialog when agent is running — prompt clears immediately,
      // restored on cancel via setPromptRef
      if (threadIsRunning && followUpMode === 'ask') {
        const { allowedTools, disallowedTools } = deriveToolLists(
          useSettingsStore.getState().toolPermissions,
        );
        pendingSendRef.current = {
          prompt,
          opts: {
            provider: opts.provider || undefined,
            model: opts.model || undefined,
            permissionMode: opts.mode || undefined,
            allowedTools,
            disallowedTools,
            fileReferences: opts.fileReferences,
            baseBranch: opts.baseBranch,
          },
          images,
        };
        setFollowUpDialogOpen(true);
        return; // prompt already cleared by PromptInput
      }

      setSending(true);

      // Toast for interrupt mode when agent is running
      if (threadIsRunning && followUpMode === 'interrupt') {
        toast.info(t('thread.interruptingAgent'));
      }

      // Always scroll to bottom when the user sends a message
      scrollingToBottomRef.current = true;
      userHasScrolledUp.current = false;
      smoothScrollPending.current = true;
      if (scrollDownRef.current) scrollDownRef.current.style.display = 'none';

      // Always show optimistic message — the server decides whether to queue or run.
      // Previously we skipped it for queue mode, but client and server can disagree
      // on whether the agent is running (e.g. after server restart), leading to a
      // state where the message appears queued in the UI but actually started running.
      startTransition(() => {
        useThreadStore
          .getState()
          .appendOptimisticMessage(
            thread.id,
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
        thread.id,
        prompt,
        {
          provider: opts.provider || undefined,
          model: opts.model || undefined,
          permissionMode: opts.mode || undefined,
          allowedTools,
          disallowedTools,
          fileReferences: opts.fileReferences,
          baseBranch: opts.baseBranch,
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
      } else if (result.value && (result.value as any).queued) {
        // Server confirmed the message was queued — remove the optimistic
        // message from the stream so it only appears in the queue widget.
        // It will be re-injected when the queue drains and the agent starts.
        useThreadStore.getState().rollbackOptimisticMessage(thread.id);
        toast.success(t('thread.messageQueued'));
      }
      setSending(false);
    },
    [t],
  );

  // Handlers for the "ask" follow-up dialog
  const handleFollowUpAction = useCallback(
    async (action: 'interrupt' | 'queue') => {
      setFollowUpDialogOpen(false);
      const pending = pendingSendRef.current;
      if (!pending) return;
      pendingSendRef.current = null;

      const thread = activeThreadRef.current;
      if (!thread) return;

      setSending(true);

      if (action === 'interrupt') {
        toast.info(t('thread.interruptingAgent'));
      }

      scrollingToBottomRef.current = true;
      userHasScrolledUp.current = false;
      smoothScrollPending.current = true;
      if (scrollDownRef.current) scrollDownRef.current.style.display = 'none';

      // Always show optimistic message — server decides whether to queue or run
      startTransition(() => {
        useThreadStore
          .getState()
          .appendOptimisticMessage(
            thread.id,
            pending.prompt,
            pending.images,
            pending.opts.model as any,
            pending.opts.permissionMode as any,
            pending.opts.fileReferences as any,
          );
      });

      const result = await api.sendMessage(
        thread.id,
        pending.prompt,
        {
          ...pending.opts,
          forceQueue: action === 'queue' ? true : undefined,
        },
        pending.images,
      );
      if (result.isErr()) {
        const err = result.error;
        if (err.type === 'INTERNAL') {
          toast.error(t('thread.sendFailed'));
        } else {
          toast.error(t('thread.sendFailedGeneric', { error: err.message }));
        }
      } else if (result.value && (result.value as any).queued) {
        useThreadStore.getState().rollbackOptimisticMessage(thread.id);
        toast.success(t('thread.messageQueued'));
      }
      setSending(false);
    },
    [t],
  );

  const handleFollowUpCancel = useCallback(() => {
    setFollowUpDialogOpen(false);
    // Restore the prompt text that was cleared when the dialog opened
    const pending = pendingSendRef.current;
    if (pending && setPromptRef.current) {
      setPromptRef.current(pending.prompt);
    }
    pendingSendRef.current = null;
  }, []);

  const handleStop = useCallback(async () => {
    const thread = activeThreadRef.current;
    if (!thread) return;
    const result = await api.stopThread(thread.id);
    if (result.isErr()) {
      console.error('Stop failed:', result.error);
    }
  }, []);

  const handlePermissionApproval = useCallback(async (toolName: string, approved: boolean) => {
    const thread = activeThreadRef.current;
    if (!thread) return;
    useThreadStore
      .getState()
      .appendOptimisticMessage(
        thread.id,
        approved ? `Approved: ${toolName}` : `Denied: ${toolName}`,
      );
    const { allowedTools, disallowedTools } = deriveToolLists(
      useSettingsStore.getState().toolPermissions,
    );
    const result = await api.approveTool(
      thread.id,
      toolName,
      approved,
      allowedTools,
      disallowedTools,
    );
    if (result.isErr()) {
      console.error('Permission approval failed:', result.error);
    }
  }, []);

  // Show new thread input when a project's "+" was clicked
  if (newThreadProjectId && !selectedThreadId) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <ProjectHeader />
        <NewThreadInput />
      </div>
    );
  }

  if (!selectedThreadId) {
    if (selectedProjectId && hasProjects) {
      return (
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <ProjectHeader />
          <NewThreadInput />
        </div>
      );
    }
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <div className="flex flex-1 items-center justify-center px-6 text-muted-foreground">
          <div className="max-w-3xl text-center">
            <p className="mb-4 text-4xl">{hasProjects ? '🚀' : '📁'}</p>
            <p className="mb-1 text-2xl font-semibold text-foreground">
              {hasProjects ? t('thread.selectOrCreate') : t('thread.addProjectFirst')}
            </p>
            <p className="text-sm">
              {hasProjects ? t('thread.threadsRunParallel') : t('thread.addProjectDescription')}
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (!activeThread) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {selectedProjectId && <ProjectHeader />}
        <div className="flex flex-1 items-center justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      </div>
    );
  }

  const uiQueuedCount = (activeThread as any).queuedCount ?? 0;
  const isRunning = activeThread.status === 'running' || uiQueuedCount > 0;
  const isExternal = activeThread.provider === 'external';
  const isIdle = activeThread.status === 'idle' && uiQueuedCount === 0;
  const currentProject = useProjectStore
    .getState()
    .projects.find((p) => p.id === activeThread.projectId);
  const followUpMode = currentProject?.followUpMode || DEFAULT_FOLLOW_UP_MODE;
  const isQueueMode = followUpMode === 'queue' || followUpMode === 'ask';

  // Setting up: worktree is being created in the background
  if (activeThread.status === 'setting_up') {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <ProjectHeader />
        <div className="flex flex-1 items-center justify-center px-4">
          <WorktreeSetupProgress steps={activeThread.setupProgress ?? []} />
        </div>
      </div>
    );
  }

  // Idle thread (backlog or not): show prompt input to start (pre-loaded with initialPrompt if available)
  if (isIdle) {
    return (
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <ProjectHeader />
        <div className="flex flex-1 items-center justify-center px-4">
          <div className="w-full max-w-3xl">
            <PromptInput
              onSubmit={handleSend}
              loading={sending}
              isNewThread
              projectId={activeThread.projectId}
              threadId={activeThread.id}
              initialPrompt={activeThread.initialPrompt}
              initialImages={(() => {
                const draftMsg = activeThread.messages?.find((m) => m.role === 'user');
                if (!draftMsg?.images) return undefined;
                try {
                  const parsed =
                    typeof draftMsg.images === 'string'
                      ? JSON.parse(draftMsg.images)
                      : draftMsg.images;
                  return parsed?.length ? parsed : undefined;
                } catch {
                  return undefined;
                }
              })()}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      <ProjectHeader />
      {activeThread?.id && <PipelineProgressBanner threadId={activeThread.id} />}

      {/* Messages + Timeline */}
      <div className="thread-container flex min-h-0 flex-1">
        {/* Messages column + input */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto"
            ref={scrollViewportRef}
            style={{ contain: 'layout style' }}
          >
            {/* Spacer pushes content to the bottom without mt-auto, which caused CLS
              as the margin shrank when messages arrived. A flex-grow spacer is inert
              and doesn't trigger CLS because the spacer itself is not painted. */}
            <div className="flex-grow" aria-hidden="true" />
            <div
              ref={contentStackRef}
              className="mx-auto w-full min-w-[320px] max-w-3xl space-y-4 px-4 py-4"
            >
              {loadingMore && (
                <div className="flex items-center justify-center py-3">
                  <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  <span className="ml-2 text-xs text-muted-foreground">
                    {t('thread.loadingOlder', 'Loading older messages\u2026')}
                  </span>
                </div>
              )}
              {!hasMore && !loadingMore && activeThread.messages.length > 0 && (
                <div className="py-2 text-center">
                  <span className="text-xs text-muted-foreground">
                    {t('thread.beginningOfConversation', 'Beginning of conversation')}
                    {activeThread.createdAt && <> &middot; {timeAgo(activeThread.createdAt, t)}</>}
                  </span>
                </div>
              )}
              {activeThread.initInfo && <InitInfoCard initInfo={activeThread.initInfo} />}

              <MemoizedMessageList
                ref={messageListRef}
                messages={stableMessages ?? EMPTY_MESSAGES}
                threadEvents={stableThreadEvents}
                compactionEvents={stableCompactionEvents}
                threadId={activeThread.id}
                threadStatus={activeThread.status}
                knownIds={knownIdsRef.current}
                prefersReducedMotion={prefersReducedMotion}
                snapshotMap={snapshotMap}
                onSend={handleSend}
                onOpenLightbox={openLightbox}
                scrollRef={scrollViewportRef}
              />

              {isRunning && !isExternal && (
                <motion.div
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease: 'easeOut' }}
                  className="flex items-center gap-2.5 py-1 text-sm text-muted-foreground"
                >
                  <D4CAnimation />
                  <span className="text-xs">{t('thread.agentWorking')}</span>
                </motion.div>
              )}

              {isRunning && isExternal && (
                <motion.div
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease: 'easeOut' }}
                  className="flex items-center gap-2.5 py-1 text-sm text-muted-foreground"
                >
                  <div className="flex items-center gap-1">
                    <span className="inline-block h-1.5 w-1.5 animate-[thinking_1.4s_ease-in-out_infinite] rounded-full bg-muted-foreground/60" />
                    <span className="inline-block h-1.5 w-1.5 animate-[thinking_1.4s_ease-in-out_0.2s_infinite] rounded-full bg-muted-foreground/60" />
                    <span className="inline-block h-1.5 w-1.5 animate-[thinking_1.4s_ease-in-out_0.4s_infinite] rounded-full bg-muted-foreground/60" />
                  </div>
                  <span className="text-xs">
                    {t('thread.runningExternally', 'Running externally\u2026')}
                  </span>
                </motion.div>
              )}

              {activeThread.status === 'waiting' && activeThread.waitingReason === 'question' && (
                <motion.div
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, ease: 'easeOut' }}
                  className="flex items-center gap-2 text-xs text-status-warning/80"
                >
                  <ShieldQuestion className="h-3.5 w-3.5 animate-pulse" />
                  {t('thread.waitingForResponse')}
                </motion.div>
              )}

              {activeThread.status === 'waiting' &&
                activeThread.waitingReason === 'permission' &&
                activeThread.pendingPermission && (
                  <motion.div
                    initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: 'easeOut' }}
                  >
                    <PermissionApprovalCard
                      toolName={activeThread.pendingPermission.toolName}
                      onApprove={() =>
                        handlePermissionApproval(activeThread.pendingPermission!.toolName, true)
                      }
                      onDeny={() =>
                        handlePermissionApproval(activeThread.pendingPermission!.toolName, false)
                      }
                    />
                  </motion.div>
                )}

              {activeThread.status === 'waiting' && !activeThread.waitingReason && (
                <motion.div
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.25, ease: 'easeOut' }}
                >
                  <WaitingActions
                    onSend={(text) =>
                      handleSend(text, {
                        model: activeThread.model,
                        mode: activeThread.permissionMode,
                      })
                    }
                  />
                </motion.div>
              )}

              {activeThread.resultInfo &&
                !isRunning &&
                activeThread.status !== 'stopped' &&
                activeThread.status !== 'interrupted' && (
                  <motion.div
                    initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: 'easeOut' }}
                  >
                    <AgentResultCard
                      status={activeThread.resultInfo.status}
                      cost={activeThread.resultInfo.cost}
                      duration={activeThread.resultInfo.duration}
                      error={activeThread.resultInfo.error}
                      onContinue={
                        activeThread.resultInfo.status === 'failed'
                          ? () =>
                              handleSend('Continue', {
                                model: activeThread.model,
                                mode: activeThread.permissionMode,
                              })
                          : undefined
                      }
                    />
                  </motion.div>
                )}

              {activeThread.status === 'interrupted' && (
                <motion.div
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease: 'easeOut' }}
                >
                  <AgentInterruptedCard
                    onContinue={() =>
                      handleSend('Continue', {
                        model: activeThread.model,
                        mode: activeThread.permissionMode,
                      })
                    }
                  />
                </motion.div>
              )}

              {activeThread.status === 'stopped' && (
                <motion.div
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease: 'easeOut' }}
                >
                  <AgentStoppedCard
                    onContinue={() =>
                      handleSend('Continue', {
                        model: activeThread.model,
                        mode: activeThread.permissionMode,
                      })
                    }
                  />
                </motion.div>
              )}
              {promptPinSpacerHeight > 0 && (
                <div aria-hidden="true" style={{ height: promptPinSpacerHeight }} />
              )}
            </div>

            {/* Input — sticky at bottom */}
            <div ref={inputDockRef} className="sticky bottom-0 z-30 bg-background">
              {/* Scroll to bottom button — visibility managed via DOM ref to avoid re-renders */}
              <div ref={scrollDownRef} className="relative" style={{ display: 'none' }}>
                <button
                  onClick={scrollToBottom}
                  data-testid="scroll-to-bottom"
                  aria-label={t('thread.scrollToBottom', 'Scroll to bottom')}
                  className="absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-muted-foreground/40 bg-secondary px-3 py-1.5 text-xs text-muted-foreground shadow-md transition-colors hover:bg-muted"
                >
                  <ArrowDown className="h-3 w-3" />
                  {t('thread.scrollToBottom', 'Scroll to bottom')}
                </button>
              </div>
              <PromptInput
                onSubmit={handleSend}
                onStop={handleStop}
                loading={sending}
                running={isRunning && !isExternal}
                threadId={activeThread.id}
                isQueueMode={isQueueMode}
                queuedCount={(activeThread as any).queuedCount ?? 0}
                queuedNextMessage={(activeThread as any).queuedNextMessage}
                setPromptRef={setPromptRef}
                placeholder={t('thread.nextPrompt')}
              />
            </div>
          </div>
        </div>

        {/* Prompt Timeline — hidden when container < 600px */}
        {timelineVisible && activeThread.messages.length > 0 && (
          <PromptTimeline
            messages={activeThread.messages}
            activeMessageId={
              visibleMessageId ??
              activeThread.messages.filter((m) => m.role === 'user' && m.content?.trim()).at(-1)?.id
            }
            threadStatus={activeThread.status}
            messagesScrollRef={scrollViewportRef}
            onScrollToMessage={(msgId, toolCallId) => {
              // Try tool call element first, then user message
              const targetId = toolCallId || msgId;
              const selector = toolCallId
                ? `[data-tool-call-id="${toolCallId}"]`
                : `[data-user-msg="${msgId}"]`;
              const el = scrollViewportRef.current?.querySelector(selector);
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              } else {
                // Item not rendered yet — expand window, then scroll after commit
                messageListRef.current?.expandToItem(targetId);
                requestAnimationFrame(() => {
                  const el2 = scrollViewportRef.current?.querySelector(selector);
                  if (el2) el2.scrollIntoView({ behavior: 'smooth', block: 'center' });
                });
              }
            }}
          />
        )}
      </div>

      {/* Image lightbox */}
      <ImageLightbox
        images={lightboxImages}
        initialIndex={lightboxIndex}
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
      />

      {/* "Ask" follow-up mode dialog */}
      <FollowUpModeDialog
        open={followUpDialogOpen}
        onInterrupt={() => handleFollowUpAction('interrupt')}
        onQueue={() => handleFollowUpAction('queue')}
        onCancel={handleFollowUpCancel}
      />
    </div>
  );
}
