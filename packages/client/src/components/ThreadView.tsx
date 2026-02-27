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
  ChevronRight,
  ChevronDown,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
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
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { useTodoSnapshots } from '@/hooks/use-todo-panel';
import { api } from '@/lib/api';
import { parseReferencedFiles } from '@/lib/parse-referenced-files';
import { timeAgo, resolveModelLabel } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { selectLastMessage, selectFirstMessage } from '@/stores/thread-selectors';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

import { D4CAnimation } from './D4CAnimation';
import { ImageLightbox } from './ImageLightbox';
import { PromptInput } from './PromptInput';
import { AgentResultCard, AgentInterruptedCard, AgentStoppedCard } from './thread/AgentStatusCards';
import { CompactionEventCard } from './thread/CompactionEventCard';
import { GitEventCard } from './thread/GitEventCard';
import { NewThreadInput } from './thread/NewThreadInput';
import { ProjectHeader } from './thread/ProjectHeader';
import { PromptTimeline } from './thread/PromptTimeline';
import { ToolCallCard } from './ToolCallCard';
import { ToolCallGroup } from './ToolCallGroup';

// Regex to match file paths like /foo/bar.ts, C:\foo\bar.ts, or file_path:line_number patterns
const FILE_PATH_RE = /(?:[A-Za-z]:[\\/]|\/)[^\s:*?"<>|,()]+(?::\d+)?/g;

import { toEditorUriWithLine, openFileInEditor } from '@/lib/editor-utils';
import { editorLabels } from '@/stores/settings-store';

// Prefetch react-markdown + remark-gfm immediately at module load time.
// By the time ThreadView renders messages, the chunks are already downloaded.
const _markdownImport = Promise.all([import('react-markdown'), import('remark-gfm')]);

const LazyMarkdownRenderer = lazy(() =>
  _markdownImport.then(([{ default: ReactMarkdown }, { default: remarkGfm }]) => {
    const remarkPlugins = [remarkGfm];
    const markdownComponents = {
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
      code: ({ className, children, ...props }: any) => {
        const isBlock = className?.startsWith('language-');
        return isBlock ? (
          <code
            className={cn(
              'block bg-muted p-2 rounded text-xs font-mono overflow-x-auto',
              className,
            )}
            {...props}
          >
            {children}
          </code>
        ) : (
          <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs" {...props}>
            {children}
          </code>
        );
      },
      pre: ({ children }: any) => (
        <pre className="my-2 overflow-x-auto rounded bg-muted p-2 font-mono">{children}</pre>
      ),
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
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="shrink-0 rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:bg-muted hover:text-foreground group-hover:opacity-100"
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
    <div className="space-y-2.5 rounded-lg border border-status-warning/20 bg-status-warning/5 p-3">
      <div className="flex items-center gap-2 text-xs text-status-warning/80">
        <Clock className="h-3.5 w-3.5" />
        {t('thread.waitingForResponse')}
      </div>

      <div className="flex gap-2">
        <button
          onClick={() => onSend('Continue')}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <CheckCircle2 className="h-3.5 w-3.5" />
          {t('thread.acceptContinue')}
        </button>
        <button
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

type ToolItem =
  | { type: 'toolcall'; tc: any }
  | { type: 'toolcall-group'; name: string; calls: any[] };

type RenderItem =
  | { type: 'message'; msg: any }
  | ToolItem
  | { type: 'toolcall-run'; items: ToolItem[] }
  | { type: 'thread-event'; event: import('@funny/shared').ThreadEvent }
  | { type: 'compaction-event'; event: import('@/stores/thread-store').CompactionEvent };

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
});

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
});

/** Get timestamp for a render item (used for chronological interleaving with events) */
function getItemTimestamp(item: RenderItem): string {
  if (item.type === 'message') return item.msg.timestamp || '';
  if (item.type === 'thread-event') return item.event.createdAt || '';
  if (item.type === 'compaction-event') return item.event.timestamp || '';
  if (item.type === 'toolcall') return item.tc.timestamp || '';
  if (item.type === 'toolcall-group') return item.calls[0]?.timestamp || '';
  if (item.type === 'toolcall-run') {
    const first = item.items[0];
    return first.type === 'toolcall' ? first.tc.timestamp || '' : first.calls[0]?.timestamp || '';
  }
  return '';
}

function buildGroupedRenderItems(
  messages: any[],
  threadEvents?: import('@funny/shared').ThreadEvent[],
  compactionEvents?: import('@/stores/thread-store').CompactionEvent[],
): RenderItem[] {
  // Flatten all messages into a single stream of items
  const flat: ({ type: 'message'; msg: any } | { type: 'toolcall'; tc: any })[] = [];
  // Collect Write tool calls that wrote plan files, so ExitPlanMode can use their content
  let lastWrittenPlanContent: string | undefined;
  for (const msg of messages) {
    const hasExitPlanMode = msg.toolCalls?.some((tc: any) => tc.name === 'ExitPlanMode');
    // Only add message bubble if there's actual text content.
    // Skip if the message has an ExitPlanMode tool call — the plan text
    // will be shown inside the ExitPlanModeCard instead.
    if (msg.content && msg.content.trim() && !hasExitPlanMode) {
      flat.push({ type: 'message', msg });
    }
    for (const tc of msg.toolCalls ?? []) {
      // Track the most recent Write to a plan file
      if (tc.name === 'Write') {
        try {
          const inp = typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input;
          const fp = (inp?.file_path || '') as string;
          if (/plan\.md$/i.test(fp) && typeof inp?.content === 'string') {
            lastWrittenPlanContent = inp.content;
          }
        } catch {
          /* ignore parse errors */
        }
      }
      // Attach plan text for ExitPlanMode: prefer the content written to plan.md,
      // then fall back to the parent assistant message content
      if (tc.name === 'ExitPlanMode') {
        tc._planText = lastWrittenPlanContent || msg.content?.trim() || undefined;
      }
      flat.push({ type: 'toolcall', tc });
    }
  }

  // Tool calls that should never be grouped (interactive, need individual response, or need per-item scroll tracking)
  const noGroup = new Set(['AskUserQuestion', 'ExitPlanMode']);

  // Group consecutive same-type tool calls (across message boundaries)
  const grouped: RenderItem[] = [];
  for (const item of flat) {
    if (item.type === 'toolcall') {
      const last = grouped[grouped.length - 1];
      if (
        !noGroup.has(item.tc.name) &&
        last?.type === 'toolcall' &&
        (last as any).tc.name === item.tc.name
      ) {
        grouped[grouped.length - 1] = {
          type: 'toolcall-group',
          name: item.tc.name,
          calls: [(last as any).tc, item.tc],
        };
      } else if (
        !noGroup.has(item.tc.name) &&
        last?.type === 'toolcall-group' &&
        last.name === item.tc.name
      ) {
        last.calls.push(item.tc);
      } else {
        grouped.push(item);
      }
    } else {
      grouped.push(item);
    }
  }

  // Deduplicate TodoWrite: only keep the last one (the floating panel handles history).
  // For TodoWrite groups, replace with a single toolcall using the last call's data.
  let lastTodoIdx = -1;
  for (let i = grouped.length - 1; i >= 0; i--) {
    const g = grouped[i];
    if (
      (g.type === 'toolcall' && g.tc.name === 'TodoWrite') ||
      (g.type === 'toolcall-group' && g.name === 'TodoWrite')
    ) {
      lastTodoIdx = i;
      break;
    }
  }
  const deduped: RenderItem[] = [];
  for (let i = 0; i < grouped.length; i++) {
    const g = grouped[i];
    const isTodoItem =
      (g.type === 'toolcall' && g.tc.name === 'TodoWrite') ||
      (g.type === 'toolcall-group' && g.name === 'TodoWrite');
    if (isTodoItem && i !== lastTodoIdx) continue; // skip earlier TodoWrites
    if (isTodoItem && g.type === 'toolcall-group') {
      // Replace group with just the last call
      deduped.push({ type: 'toolcall', tc: g.calls[g.calls.length - 1] });
    } else {
      deduped.push(g);
    }
  }

  // Wrap consecutive tool call items into a single toolcall-run for tighter spacing
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

  // Interleave thread events (git operations) and compaction events chronologically
  const hasEvents = threadEvents?.length || compactionEvents?.length;
  if (!hasEvents) return final;

  const eventItems: RenderItem[] = (threadEvents ?? [])
    .filter((e) => e.type !== 'git:changed')
    .map((e) => ({ type: 'thread-event' as const, event: e }));

  const compactionItems: RenderItem[] = (compactionEvents ?? []).map((e) => ({
    type: 'compaction-event' as const,
    event: e,
  }));

  const merged = [...final, ...eventItems, ...compactionItems];
  merged.sort((a, b) => {
    const tsA = getItemTimestamp(a);
    const tsB = getItemTimestamp(b);
    if (!tsA && !tsB) return 0;
    if (!tsA) return -1;
    if (!tsB) return 1;
    return tsA.localeCompare(tsB);
  });

  return merged;
}

const COLLAPSED_MAX_H = 128; // px – roughly 8 lines of text

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
        )}
        style={!expanded && isOverflowing ? { maxHeight: COLLAPSED_MAX_H } : undefined}
      >
        {content}
      </pre>
      {isOverflowing && !expanded && (
        <div className="pointer-events-none absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-foreground to-transparent" />
      )}
      {isOverflowing && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1 flex items-center gap-1 text-[11px] text-background/60 transition-colors hover:text-background/90"
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

/** Get a stable key for a render item */
function getItemKey(item: RenderItem): string {
  if (item.type === 'message') return item.msg.id;
  if (item.type === 'toolcall') return item.tc.id;
  if (item.type === 'toolcall-group') return item.calls[0].id;
  if (item.type === 'toolcall-run') {
    const first = item.items[0];
    return first.type === 'toolcall' ? first.tc.id : first.calls[0].id;
  }
  if (item.type === 'thread-event') return item.event.id;
  if (item.type === 'compaction-event') return `compact-${item.event.timestamp}`;
  return '';
}

/* ── Windowed rendering constants ─────────────────────────────────── */
const INITIAL_WINDOW = 30;
const EXPAND_BATCH = 20;

function estimateItemHeight(item: RenderItem): number {
  if (item.type === 'message') return item.msg.role === 'user' ? 80 : 120;
  if (item.type === 'toolcall') return 44;
  if (item.type === 'toolcall-group') return 44;
  if (item.type === 'toolcall-run') return 44 * item.items.length;
  if (item.type === 'thread-event') return 32;
  if (item.type === 'compaction-event') return 32;
  return 60;
}

interface MemoizedMessageListHandle {
  expandToItem: (id: string) => void;
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
              className={
                tc.name === 'AskUserQuestion' ||
                tc.name === 'ExitPlanMode' ||
                tc.name === 'TodoWrite' ||
                tc.name === 'Edit'
                  ? 'rounded-lg border border-border'
                  : undefined
              }
              data-tool-call-id={tc.id}
              {...(snapshotMap.has(tc.id) ? { 'data-todo-snapshot': snapshotMap.get(tc.id) } : {})}
            >
              <ToolCallCard
                name={tc.name}
                input={tc.input}
                output={tc.output}
                planText={tc._planText}
                onRespond={
                  tc.name === 'AskUserQuestion' || tc.name === 'ExitPlanMode'
                    ? (answer: string) => {
                        useThreadStore
                          .getState()
                          .handleWSToolOutput(threadId, { toolCallId: tc.id, output: answer });
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
              className={
                ti.name === 'AskUserQuestion' ||
                ti.name === 'ExitPlanMode' ||
                ti.name === 'TodoWrite' ||
                ti.name === 'Edit'
                  ? 'rounded-lg border border-border'
                  : undefined
              }
              data-tool-call-id={ti.calls[0].id}
              {...(groupSnapshotIdx >= 0 ? { 'data-todo-snapshot': groupSnapshotIdx } : {})}
            >
              <ToolCallGroup
                name={ti.name}
                calls={ti.calls}
                onRespond={
                  ti.name === 'AskUserQuestion' || ti.name === 'ExitPlanMode'
                    ? (answer: string) => {
                        for (const call of ti.calls) {
                          if (!call.output) {
                            useThreadStore.getState().handleWSToolOutput(threadId, {
                              toolCallId: call.id,
                              output: answer,
                            });
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
      [snapshotMap, threadId, onSend],
    );

    return (
      <>
        {hasHiddenItems && <div style={{ height: spacerHeight }} aria-hidden="true" />}
        {visibleItems.map((item) => {
          const key = getItemKey(item);

          if (item.type === 'message') {
            const msg = item.msg;
            return (
              <div
                key={key}
                style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 60px' }}
                className={cn(
                  'relative group text-sm',
                  msg.role === 'user'
                    ? 'max-w-[80%] ml-auto rounded-lg px-3 py-2 bg-foreground text-background'
                    : 'w-full text-foreground',
                )}
                {...(msg.role === 'user' ? { 'data-user-msg': msg.id } : {})}
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
                {msg.role === 'user' ? (
                  (() => {
                    const { files, cleanContent } = parseReferencedFiles(msg.content);
                    return (
                      <>
                        {files.length > 0 && (
                          <div className="mb-1.5 flex flex-wrap gap-1">
                            {files.map((file) => (
                              <span
                                key={file}
                                className="inline-flex items-center gap-1 rounded bg-background/20 px-1.5 py-0.5 font-mono text-xs text-background/70"
                                title={file}
                              >
                                <FileText className="h-3 w-3 shrink-0" />
                                {file.split('/').pop()}
                              </span>
                            ))}
                          </div>
                        )}
                        <UserMessageContent content={cleanContent.trim()} />
                        {(msg.model || msg.permissionMode) && (
                          <div className="mt-1.5 flex gap-1">
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
                        )}
                      </>
                    );
                  })()
                ) : (
                  <div className="overflow-x-auto break-words text-sm leading-relaxed">
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
                      <span className="select-none text-[10px] text-muted-foreground/60">
                        {timeAgo(msg.timestamp, t)}
                      </span>
                    </div>
                  </div>
                )}
              </div>
            );
          }

          if (item.type === 'toolcall' || item.type === 'toolcall-group') {
            return (
              <div
                key={key}
                style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 40px' }}
              >
                {renderToolItem(item)}
              </div>
            );
          }

          if (item.type === 'toolcall-run') {
            return (
              <div
                key={key}
                style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 40px' }}
              >
                <div className="space-y-1">{item.items.map(renderToolItem)}</div>
              </div>
            );
          }

          if (item.type === 'thread-event') {
            return (
              <div
                key={key}
                style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 32px' }}
              >
                <GitEventCard event={item.event} />
              </div>
            );
          }

          if (item.type === 'compaction-event') {
            return (
              <div
                key={key}
                style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 32px' }}
              >
                <CompactionEventCard event={item.event} />
              </div>
            );
          }

          return null;
        })}
      </>
    );
  }),
);

export function ThreadView() {
  const { t } = useTranslation();
  useMinuteTick(); // re-render every 60s so timeAgo stays fresh
  const activeThread = useThreadStore((s) => s.activeThread);
  const selectedThreadId = useThreadStore((s) => s.selectedThreadId);
  const selectedProjectId = useProjectStore((s) => s.selectedProjectId);
  const newThreadProjectId = useUIStore((s) => s.newThreadProjectId);
  const hasProjects = useProjectStore((s) => s.projects.length > 0);
  const loadOlderMessages = useThreadStore((s) => s.loadOlderMessages);
  const hasMore = activeThread?.hasMore ?? false;
  const loadingMore = activeThread?.loadingMore ?? false;
  const [sending, setSending] = useState(false);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const userHasScrolledUp = useRef(false);
  const smoothScrollPending = useRef(false);
  // Tracks the thread ID for which we've already forced a scroll-to-bottom.
  // Used by the fingerprint effect to force one extra scroll after the thread
  // switch effect, catching content that renders after the initial commit.
  const scrolledThreadRef = useRef<string | null>(null);
  const prevOldestIdRef = useRef<string | null>(null);
  const prevScrollHeightRef = useRef(0);
  const scrollDownRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<MemoizedMessageListHandle>(null);
  const [visibleMessageId, setVisibleMessageId] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxImages, setLightboxImages] = useState<{ src: string; alt: string }[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const prefersReducedMotion = useReducedMotion();
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

  // Map tool call IDs to snapshot indices for data-attribute lookup
  const snapshotMap = useMemo(() => {
    const map = new Map<string, number>();
    snapshots.forEach((s, i) => map.set(s.toolCallId, i));
    return map;
  }, [snapshots]);

  // Scroll to bottom when opening or switching threads.
  // useLayoutEffect fires before browser paint, preventing CLS from scroll jumps.
  useLayoutEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport || !activeThread) return;

    // Reset the scroll-up flag and pagination refs, then scroll to bottom
    userHasScrolledUp.current = false;
    prevOldestIdRef.current = null;
    prevScrollHeightRef.current = 0;
    // Mark that the fingerprint effect should also force-scroll for this thread,
    // covering content that renders after the initial commit (e.g. deferred
    // markdown rendering, syntax highlighting, lazy images).
    scrolledThreadRef.current = null;
    // Scroll immediately (before paint) to prevent layout shift
    viewport.scrollTop = viewport.scrollHeight;
    // Also scroll after the browser finishes layout/paint to catch any
    // content that rendered asynchronously (e.g. images, animations).
    const rafId = requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
      // A second rAF covers deferred renders (syntax highlighting, lazy
      // components) that only update the DOM in the frame *after* the first
      // post-commit paint.
      requestAnimationFrame(() => {
        viewport.scrollTop = viewport.scrollHeight;
      });
    });
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only scroll on thread switch; activeThread is used for null check but changes on every message
  }, [activeThread?.id]);

  const openLightbox = useCallback((images: { src: string; alt: string }[], index: number) => {
    setLightboxImages(images);
    setLightboxIndex(index);
    setLightboxOpen(true);
  }, []);

  const lastMessage = selectLastMessage(activeThread);
  const scrollFingerprint = [
    activeThread?.messages?.length,
    lastMessage?.content?.length,
    lastMessage?.toolCalls?.length,
    activeThread?.status,
    !!activeThread?.initInfo, // trigger scroll-to-bottom when initInfo arrives (prevents CLS)
  ].join(':');

  // Helper: schedule a non-critical state update during idle time
  const scheduleIdle = useCallback((fn: () => void) => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(fn);
    else setTimeout(fn, 0);
  }, []);

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
      const isAtBottom = scrollHeight - scrollTop - clientHeight <= 80;
      userHasScrolledUp.current = !isAtBottom;

      // Update scroll-to-bottom button visibility via DOM (fast path, no React state)
      const shouldShow = hasOverflow && !isAtBottom;
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

  // Scroll to bottom whenever the fingerprint changes (new messages, status changes).
  // Only scrolls if the user is already at the bottom (sticky behavior).
  // useLayoutEffect prevents CLS by scrolling before the browser paints.
  useLayoutEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    // Force scroll when this is the first fingerprint change for a newly
    // opened thread.  The thread-switch effect sets scrolledThreadRef to null;
    // here we detect that the current thread hasn't been "claimed" yet and
    // force-scroll regardless of the userHasScrolledUp flag.
    const forceScroll = activeThread?.id != null && scrolledThreadRef.current !== activeThread.id;
    if (forceScroll && activeThread?.id) {
      scrolledThreadRef.current = activeThread.id;
      userHasScrolledUp.current = false;
    }

    if (!userHasScrolledUp.current) {
      if (smoothScrollPending.current) {
        // User just sent a message — smooth scroll after paint
        smoothScrollPending.current = false;
        requestAnimationFrame(() => {
          viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
        });
      } else {
        viewport.scrollTop = viewport.scrollHeight;
      }
      // When at bottom, sync visibleMessageId to the last user message.
      // Setting scrollTop programmatically doesn't always fire a scroll event,
      // so the scroll handler may never update visibleMessageId.
      if (lastUserMsgIdRef.current) {
        const id = lastUserMsgIdRef.current;
        scheduleIdle(() => setVisibleMessageId(id));
      }
    }
    // Hide scroll-to-bottom button via DOM if content doesn't overflow
    const hasOverflow = viewport.scrollHeight > viewport.clientHeight + 10;
    if (!hasOverflow && scrollDownRef.current) {
      scrollDownRef.current.style.display = 'none';
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- activeThread.messages is already captured via scrollFingerprint; adding it directly would cause redundant scroll operations
  }, [scrollFingerprint]);

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
    userHasScrolledUp.current = false;
    if (scrollDownRef.current) scrollDownRef.current.style.display = 'none';
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
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
        fileReferences?: { path: string }[];
        baseBranch?: string;
      },
      images?: any[],
    ) => {
      if (sendingRef.current) return;
      const thread = activeThreadRef.current;
      if (!thread) return;
      setSending(true);

      const threadIsRunning = thread.status === 'running';
      const currentProject = useProjectStore
        .getState()
        .projects.find((p) => p.id === thread.projectId);
      const threadIsQueueMode = currentProject?.followUpMode === 'queue';

      // Toast for interrupt mode when agent is running
      if (threadIsRunning && !threadIsQueueMode) {
        toast.info(t('thread.interruptingAgent'));
      }

      // Always scroll to bottom when the user sends a message (smooth)
      userHasScrolledUp.current = false;
      smoothScrollPending.current = true;
      if (scrollDownRef.current) scrollDownRef.current.style.display = 'none';

      startTransition(() => {
        useThreadStore
          .getState()
          .appendOptimisticMessage(thread.id, prompt, images, opts.model as any, opts.mode as any);
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
        console.error('Send failed:', result.error);
      } else if (threadIsRunning && threadIsQueueMode) {
        toast.success(t('thread.messageQueued'));
      }
      setSending(false);
    },
    [t],
  );

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

  const isRunning = activeThread.status === 'running';
  const isExternal = activeThread.provider === 'external';
  const isIdle = activeThread.status === 'idle';
  const currentProject = useProjectStore
    .getState()
    .projects.find((p) => p.id === activeThread.projectId);
  const isQueueMode = currentProject?.followUpMode === 'queue';

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
            <div className="mx-auto w-full min-w-[320px] max-w-3xl space-y-4 px-4 py-4">
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
                messages={activeThread.messages ?? []}
                threadEvents={activeThread.threadEvents}
                compactionEvents={activeThread.compactionEvents}
                threadId={activeThread.id}
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
            </div>

            {/* Input — sticky at bottom */}
            {!(activeThread.status === 'waiting' && activeThread.waitingReason === 'question') && (
              <div className="sticky bottom-0 z-10 bg-background">
                {/* Scroll to bottom button — visibility managed via DOM ref to avoid re-renders */}
                <div ref={scrollDownRef} className="relative" style={{ display: 'none' }}>
                  <button
                    onClick={scrollToBottom}
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
                  isQueueMode={isQueueMode}
                  queuedCount={(activeThread as any).queuedCount ?? 0}
                  placeholder={t('thread.nextPrompt')}
                />
              </div>
            )}
          </div>
        </div>

        {/* Prompt Timeline — hidden when container < 600px */}
        {activeThread.messages.length > 0 && (
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
    </div>
  );
}
