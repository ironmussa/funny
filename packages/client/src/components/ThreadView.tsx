import { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo, memo, startTransition, lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { useAppStore } from '@/stores/app-store';
import { useUIStore } from '@/stores/ui-store';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Loader2, Clock, Copy, Check, Send, CheckCircle2, XCircle, ArrowDown, ShieldQuestion, FileText, ChevronRight, ChevronDown } from 'lucide-react';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { timeAgo, resolveModelLabel } from '@/lib/thread-utils';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { api } from '@/lib/api';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import { useThreadStore } from '@/stores/thread-store';
import { selectLastMessage, selectFirstMessage } from '@/stores/thread-selectors';
import { useProjectStore } from '@/stores/project-store';
import { PromptInput } from './PromptInput';
import { ToolCallCard } from './ToolCallCard';
import { ToolCallGroup } from './ToolCallGroup';
import { ImageLightbox } from './ImageLightbox';
import { Badge } from '@/components/ui/badge';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { ProjectHeader } from './thread/ProjectHeader';
import { NewThreadInput } from './thread/NewThreadInput';
import { AgentResultCard, AgentInterruptedCard, AgentStoppedCard } from './thread/AgentStatusCards';
import { TodoPanel } from './thread/TodoPanel';
import { PromptTimeline } from './thread/PromptTimeline';
import { parseReferencedFiles } from '@/lib/parse-referenced-files';
import { useTodoSnapshots } from '@/hooks/use-todo-panel';

const D4C_FRAMES = ['🐇', '🌀', '🐰', '⭐'];
const D4C_INTERVAL = 600;

function D4CAnimation() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % D4C_FRAMES.length), D4C_INTERVAL);
    return () => clearInterval(id);
  }, []);
  return <span className="inline-block text-base leading-none w-5 text-center">{D4C_FRAMES[frame]}</span>;
}

// Regex to match file paths like /foo/bar.ts, C:\foo\bar.ts, or file_path:line_number patterns
const FILE_PATH_RE = /(?:[A-Za-z]:[\\\/]|\/)[^\s:*?"<>|,()]+(?::\d+)?/g;

import { toEditorUriWithLine, openFileInEditor, getEditorLabel } from '@/lib/editor-utils';
import { editorLabels } from '@/stores/settings-store';

// Lazy-load react-markdown + remark-gfm to reduce initial bundle (improves LCP)
const LazyMarkdownRenderer = lazy(() =>
  Promise.all([
    import('react-markdown'),
    import('remark-gfm'),
  ]).then(([{ default: ReactMarkdown }, { default: remarkGfm }]) => {
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
              <a href={uri} className="text-primary hover:underline" title={`Open in ${label}: ${text}`}>
                {children}
              </a>
            );
          }
          return (
            <button
              onClick={() => openFileInEditor(fileMatch[0], editor)}
              className="text-primary hover:underline cursor-pointer inline"
              title={`Open in ${label}: ${text}`}
            >
              {children}
            </button>
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

    function MarkdownRenderer({ content }: { content: string }) {
      return (
        <ReactMarkdown remarkPlugins={remarkPlugins} components={markdownComponents}>
          {content}
        </ReactMarkdown>
      );
    }
    return { default: MarkdownRenderer };
  })
);

export const MessageContent = memo(function MessageContent({ content }: { content: string }) {
  return (
    <div className="prose prose-sm max-w-none">
      <Suspense fallback={<div className="text-sm text-muted-foreground whitespace-pre-wrap">{content}</div>}>
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
      className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded hover:bg-muted text-muted-foreground hover:text-foreground"
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
          className="flex-1 h-auto py-1.5"
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
          onClick={handleApprove}
          disabled={!!loading}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors",
            loading && "opacity-50 pointer-events-none"
          )}
        >
          {loading === 'approve' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
          {t('thread.approvePermission')}
        </button>
        <button
          onClick={handleDeny}
          disabled={!!loading}
          className={cn(
            "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium border border-border bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 transition-colors",
            loading && "opacity-50 pointer-events-none"
          )}
        >
          {loading === 'deny' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
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

function InitInfoCard({ initInfo }: { initInfo: { tools: string[]; cwd: string; model: string } }) {
  const { t } = useTranslation();
  const { builtIn, mcpGroups } = useMemo(() => groupTools(initInfo.tools), [initInfo.tools]);

  return (
    <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-1">
      <div className="flex items-center gap-2">
        <span className="font-medium">{t('initInfo.model')}</span>
        <span className="font-mono">{resolveModelLabel(initInfo.model, t)}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="font-medium">{t('initInfo.cwd')}</span>
        <span className="font-mono truncate">{initInfo.cwd}</span>
      </div>
      <div className="flex items-start gap-2">
        <span className="font-medium shrink-0">{t('initInfo.tools')}</span>
        <div className="font-mono flex flex-wrap gap-1 items-start">
          {builtIn.length === 0 && mcpGroups.size === 0 && (
            <span className="text-muted-foreground/60 italic">{t('initInfo.providerManaged')}</span>
          )}
          {builtIn.map((tool) => (
            <span key={tool} className="bg-secondary px-1.5 py-0.5 rounded text-xs">
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
}

function McpToolGroup({ serverName, toolNames }: { serverName: string; toolNames: string[] }) {
  const [open, setOpen] = useState(false);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="inline-flex items-center gap-0.5 bg-primary/10 px-1.5 py-0.5 rounded text-xs hover:bg-primary/20 cursor-pointer transition-colors">
        <ChevronRight className={cn('h-3 w-3 transition-transform', open && 'rotate-90')} />
        {serverName} ({toolNames.length})
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-wrap gap-1 mt-1">
        {toolNames.map((name) => (
          <span key={name} className="bg-secondary px-1.5 py-0.5 rounded text-xs">
            {name}
          </span>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

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
  const noGroup = new Set(['AskUserQuestion', 'ExitPlanMode']);

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

  // Deduplicate TodoWrite: only keep the last one (the floating panel handles history).
  // For TodoWrite groups, replace with a single toolcall using the last call's data.
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

  return final;
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
          !expanded && isOverflowing && 'overflow-hidden'
        )}
        style={!expanded && isOverflowing ? { maxHeight: COLLAPSED_MAX_H } : undefined}
      >
        {content}
      </pre>
      {isOverflowing && !expanded && (
        <div className="absolute bottom-0 left-0 right-0 h-10 bg-gradient-to-t from-foreground to-transparent pointer-events-none" />
      )}
      {isOverflowing && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="flex items-center gap-1 mt-1 text-[11px] text-background/60 hover:text-background/90 transition-colors"
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

/** Memoized message list to avoid rebuilding the entire list on every render */
const MemoizedMessageList = memo(function MemoizedMessageList({
  messages,
  threadId,
  knownIds,
  prefersReducedMotion,
  snapshotMap,
  onSend,
  onOpenLightbox,
}: {
  messages: any[];
  threadId: string;
  knownIds: Set<string>;
  prefersReducedMotion: boolean | null;
  snapshotMap: Map<string, number>;
  onSend: (prompt: string, opts: { model: string; mode: string }) => void;
  onOpenLightbox: (images: { src: string; alt: string }[], index: number) => void;
}) {
  const { t } = useTranslation();

  const groupedItems = useMemo(() => buildGroupedRenderItems(messages), [messages]);

  const renderToolItem = useCallback((ti: ToolItem) => {
    if (ti.type === 'toolcall') {
      const tc = ti.tc;
      return (
        <motion.div
          key={tc.id}
          initial={knownIds.has(tc.id) || prefersReducedMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className={(tc.name === 'AskUserQuestion' || tc.name === 'ExitPlanMode' || tc.name === 'TodoWrite' || tc.name === 'Edit') ? 'border border-border rounded-lg' : undefined}
          data-tool-call-id={tc.id}
          {...(snapshotMap.has(tc.id) ? { 'data-todo-snapshot': snapshotMap.get(tc.id) } : {})}
        >
          <ToolCallCard
            name={tc.name}
            input={tc.input}
            output={tc.output}
            onRespond={(tc.name === 'AskUserQuestion' || tc.name === 'ExitPlanMode') ? (answer: string) => {
              useAppStore.getState().handleWSToolOutput(threadId, { toolCallId: tc.id, output: answer });
              onSend(answer, { model: '', mode: '' });
            } : undefined}
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
          initial={knownIds.has(ti.calls[0].id) || prefersReducedMotion ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className={(ti.name === 'AskUserQuestion' || ti.name === 'ExitPlanMode' || ti.name === 'TodoWrite' || ti.name === 'Edit') ? 'border border-border rounded-lg' : undefined}
          data-tool-call-id={ti.calls[0].id}
          {...(groupSnapshotIdx >= 0 ? { 'data-todo-snapshot': groupSnapshotIdx } : {})}
        >
          <ToolCallGroup
            name={ti.name}
            calls={ti.calls}
            onRespond={(ti.name === 'AskUserQuestion' || ti.name === 'ExitPlanMode')
              ? (answer: string) => {
                for (const call of ti.calls) {
                  if (!call.output) {
                    useAppStore.getState().handleWSToolOutput(threadId, { toolCallId: call.id, output: answer });
                  }
                }
                onSend(answer, { model: '', mode: '' });
              }
              : undefined}
          />
        </motion.div>
      );
    }
    return null;
  }, [knownIds, prefersReducedMotion, snapshotMap, threadId, onSend]);

  return (
    <>
      {groupedItems.map((item) => {
        if (item.type === 'message') {
          const msg = item.msg;
          return (
            <motion.div
              key={msg.id}
              initial={knownIds.has(msg.id) || prefersReducedMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className={cn(
                'relative group text-sm',
                msg.role === 'user'
                  ? 'max-w-[80%] ml-auto rounded-lg px-3 py-2 bg-foreground text-background'
                  : 'w-full text-foreground'
              )}
              {...(msg.role === 'user' ? { 'data-user-msg': msg.id } : {})}
            >
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
                        width={160}
                        height={160}
                        className="max-h-40 rounded border border-border cursor-pointer hover:opacity-80 transition-opacity"
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
                        <div className="flex flex-wrap gap-1 mb-1.5">
                          {files.map((file) => (
                            <span
                              key={file}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 text-xs font-mono bg-background/20 rounded text-background/70"
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
                        <div className="flex gap-1 mt-1.5">
                          {msg.model && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-medium bg-background/10 text-background/60 border-background/20">
                              {resolveModelLabel(msg.model, t)}
                            </Badge>
                          )}
                          {msg.permissionMode && (
                            <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-medium bg-background/10 text-background/60 border-background/20">
                              {t(`prompt.${msg.permissionMode}`)}
                            </Badge>
                          )}
                        </div>
                      )}
                    </>
                  );
                })()
              ) : (
                <div className="text-sm leading-relaxed break-words overflow-x-auto">
                  <div className="flex items-start gap-2">
                    {msg.author && (
                      <Avatar className="h-5 w-5 shrink-0 mt-0.5">
                        <AvatarFallback className="text-[10px] font-medium bg-primary/10 text-primary">
                          {msg.author.slice(0, 2).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                    )}
                    <div className="flex-1 min-w-0">
                      {msg.author && (
                        <span className="text-[10px] font-medium text-primary/70 mb-0.5 block">{msg.author}</span>
                      )}
                      <MessageContent content={msg.content.trim()} />
                    </div>
                    <CopyButton content={msg.content} />
                  </div>
                  <div className="mt-1">
                    <span className="text-[10px] text-muted-foreground/60 select-none">
                      {timeAgo(msg.timestamp, t)}
                    </span>
                  </div>
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
    </>
  );
});

export function ThreadView() {
  const { t } = useTranslation();
  useMinuteTick(); // re-render every 60s so timeAgo stays fresh
  const activeThread = useThreadStore(s => s.activeThread);
  const selectedThreadId = useThreadStore(s => s.selectedThreadId);
  const selectedProjectId = useProjectStore(s => s.selectedProjectId);
  const newThreadProjectId = useUIStore(s => s.newThreadProjectId);
  const hasProjects = useProjectStore(s => s.projects.length > 0);
  const loadOlderMessages = useThreadStore(s => s.loadOlderMessages);
  const hasMore = activeThread?.hasMore ?? false;
  const loadingMore = activeThread?.loadingMore ?? false;
  const [sending, setSending] = useState(false);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const userHasScrolledUp = useRef(false);
  const smoothScrollPending = useRef(false);
  const prevOldestIdRef = useRef<string | null>(null);
  const prevScrollHeightRef = useRef(0);
  const [showScrollDown, setShowScrollDown] = useState(false);
  const scrollDownRef = useRef<HTMLDivElement>(null);
  const todoThrottleRef = useRef(0);
  const [visibleMessageId, setVisibleMessageId] = useState<string | null>(null);
  const visibleMsgThrottleRef = useRef(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxImages, setLightboxImages] = useState<{ src: string; alt: string }[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [todoPanelDismissed, setTodoPanelDismissed] = useState(false);
  const [currentSnapshotIdx, setCurrentSnapshotIdx] = useState(-1);
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

  // Reset dismissed state and snapshot index when switching threads
  useEffect(() => {
    setTodoPanelDismissed(false);
    setCurrentSnapshotIdx(-1);
  }, [activeThread?.id]);

  // Scroll to bottom when opening or switching threads.
  // useLayoutEffect fires before browser paint, preventing CLS from scroll jumps.
  useLayoutEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport || !activeThread) return;

    // Reset the scroll-up flag and pagination refs, then scroll to bottom
    userHasScrolledUp.current = false;
    prevOldestIdRef.current = null;
    prevScrollHeightRef.current = 0;
    // Scroll immediately (before paint) to prevent layout shift
    viewport.scrollTop = viewport.scrollHeight;
    // Also scroll after the browser finishes layout/paint to catch any
    // content that rendered asynchronously (e.g. images, animations).
    const rafId = requestAnimationFrame(() => {
      viewport.scrollTop = viewport.scrollHeight;
    });
    return () => cancelAnimationFrame(rafId);
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

  const lastMessage = selectLastMessage(activeThread);
  const scrollFingerprint = [
    activeThread?.messages?.length,
    lastMessage?.content?.length,
    lastMessage?.toolCalls?.length,
    activeThread?.status,
  ].join(':');

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    // Expensive: queries DOM for todo-snapshot elements and measures layout.
    // Throttled to run at most every 150ms to avoid blocking the main thread.
    const updateTodoSnapshot = (isAtBottom: boolean) => {
      const now = performance.now();
      if (now - todoThrottleRef.current < 150) return;
      todoThrottleRef.current = now;

      const todoEls = viewport.querySelectorAll<HTMLElement>('[data-todo-snapshot]');
      if (todoEls.length === 0) {
        setCurrentSnapshotIdx(-1);
        return;
      }
      if (isAtBottom) {
        let maxIdx = -1;
        todoEls.forEach((el) => {
          const idx = parseInt(el.dataset.todoSnapshot!, 10);
          if (idx > maxIdx) maxIdx = idx;
        });
        setCurrentSnapshotIdx(maxIdx);
      } else {
        const viewportRect = viewport.getBoundingClientRect();
        const threshold = viewportRect.top + viewportRect.height * 0.5;
        const firstRect = todoEls[0].getBoundingClientRect();
        const lastRect = todoEls[todoEls.length - 1].getBoundingClientRect();
        if (threshold < firstRect.top || threshold > lastRect.bottom + 150) {
          setCurrentSnapshotIdx(-1);
        } else {
          let latestIdx = -1;
          todoEls.forEach((el) => {
            const rect = el.getBoundingClientRect();
            if (rect.top <= threshold) {
              const idx = parseInt(el.dataset.todoSnapshot!, 10);
              if (idx > latestIdx) latestIdx = idx;
            }
          });
          setCurrentSnapshotIdx(latestIdx >= 0 ? latestIdx : -1);
        }
      }
    };

    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport;
      const hasOverflow = scrollHeight > clientHeight + 10;
      const isAtBottom = scrollHeight - scrollTop - clientHeight <= 80;
      userHasScrolledUp.current = !isAtBottom;

      // Update scroll-to-bottom button visibility via DOM (fast path)
      const shouldShow = hasOverflow && !isAtBottom;
      if (scrollDownRef.current) {
        scrollDownRef.current.style.display = shouldShow ? '' : 'none';
      }
      // Update React state only when the value actually changes (for PromptTimeline)
      setShowScrollDown((prev) => prev !== shouldShow ? shouldShow : prev);

      // Load older messages when scrolled near the top
      if (scrollTop < 200 && hasMore && !loadingMore) {
        loadOlderMessages();
      }

      // Throttled: expensive DOM queries for todo snapshot tracking
      updateTodoSnapshot(isAtBottom);

      // Track which user message is currently visible for timeline highlighting
      const now2 = performance.now();
      if (now2 - visibleMsgThrottleRef.current >= 100) {
        visibleMsgThrottleRef.current = now2;
        const userEls = viewport.querySelectorAll<HTMLElement>('[data-user-msg]');
        if (userEls.length > 0) {
          if (isAtBottom) {
            // At bottom → highlight the last user message
            setVisibleMessageId(userEls[userEls.length - 1].dataset.userMsg!);
          } else {
            // Find the last user message whose top is above the viewport center
            const viewportRect = viewport.getBoundingClientRect();
            const threshold = viewportRect.top + viewportRect.height * 0.4;
            let found: string | null = null;
            userEls.forEach((el) => {
              if (el.getBoundingClientRect().top <= threshold) {
                found = el.dataset.userMsg!;
              }
            });
            setVisibleMessageId(found);
          }
        }
      }
    };

    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, [activeThread?.id, hasMore, loadingMore, loadOlderMessages]);

  // Scroll to bottom whenever the fingerprint changes (new messages, status changes).
  // Only scrolls if the user is already at the bottom (sticky behavior).
  // useLayoutEffect prevents CLS by scrolling before the browser paints.
  useLayoutEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

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
    }
    // Hide scroll-to-bottom button via DOM if content doesn't overflow
    const hasOverflow = viewport.scrollHeight > viewport.clientHeight + 10;
    if (!hasOverflow && scrollDownRef.current) {
      scrollDownRef.current.style.display = 'none';
    }
  }, [scrollFingerprint]);

  // Preserve scroll position when older messages are prepended
  useLayoutEffect(() => {
    const oldestId = selectFirstMessage(activeThread)?.id ?? null;
    const viewport = scrollViewportRef.current;

    if (
      viewport &&
      prevOldestIdRef.current &&
      oldestId &&
      prevOldestIdRef.current !== oldestId
    ) {
      const addedHeight = viewport.scrollHeight - prevScrollHeightRef.current;
      viewport.scrollTop += addedHeight;
    }

    prevOldestIdRef.current = oldestId;
    if (viewport) {
      prevScrollHeightRef.current = viewport.scrollHeight;
    }
  }, [selectFirstMessage(activeThread)?.id]);

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

  const handleSend = useCallback(async (prompt: string, opts: { provider?: string; model: string; mode: string; fileReferences?: { path: string }[] }, images?: any[]) => {
    if (sendingRef.current) return;
    const thread = activeThreadRef.current;
    if (!thread) return;
    setSending(true);

    const threadIsRunning = thread.status === 'running';
    const currentProject = useProjectStore.getState().projects.find(p => p.id === thread.projectId);
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
      useAppStore.getState().appendOptimisticMessage(
        thread.id,
        prompt,
        images,
        opts.model as any,
        opts.mode as any
      );
    });

    const { allowedTools, disallowedTools } = deriveToolLists(useSettingsStore.getState().toolPermissions);
    const result = await api.sendMessage(thread.id, prompt, { provider: opts.provider || undefined, model: opts.model || undefined, permissionMode: opts.mode || undefined, allowedTools, disallowedTools, fileReferences: opts.fileReferences }, images);
    if (result.isErr()) {
      console.error('Send failed:', result.error);
    } else if (threadIsRunning && threadIsQueueMode) {
      toast.success(t('thread.messageQueued'));
    }
    setSending(false);
  }, [t]);

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
    useAppStore.getState().appendOptimisticMessage(
      thread.id,
      approved ? `Approved: ${toolName}` : `Denied: ${toolName}`
    );
    const { allowedTools, disallowedTools } = deriveToolLists(useSettingsStore.getState().toolPermissions);
    const result = await api.approveTool(thread.id, toolName, approved, allowedTools, disallowedTools);
    if (result.isErr()) {
      console.error('Permission approval failed:', result.error);
    }
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
    if (selectedProjectId && hasProjects) {
      return (
        <div className="flex-1 flex flex-col h-full min-w-0">
          <ProjectHeader />
          <NewThreadInput />
        </div>
      );
    }
    return (
      <div className="flex-1 flex flex-col h-full min-w-0">
        <div className="flex-1 flex items-center justify-center text-muted-foreground px-6">
          <div className="text-center max-w-3xl">
            <p className="text-4xl mb-4">{hasProjects ? '🚀' : '📁'}</p>
            <p className="text-2xl font-semibold text-foreground mb-1">
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
      <div className="flex-1 flex flex-col h-full min-w-0">
        {selectedProjectId && <ProjectHeader />}
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
        </div>
      </div>
    );
  }

  const isRunning = activeThread.status === 'running';
  const isExternal = activeThread.provider === 'external';
  const isIdle = activeThread.status === 'idle';
  const currentProject = useProjectStore.getState().projects.find(p => p.id === activeThread.projectId);
  const isQueueMode = currentProject?.followUpMode === 'queue';

  // Idle thread (backlog or not): show prompt input to start (pre-loaded with initialPrompt if available)
  if (isIdle) {
    return (
      <div className="flex-1 flex flex-col h-full min-w-0">
        <ProjectHeader />
        <div className="flex-1 flex items-center justify-center text-muted-foreground px-6">
          <div className="text-center max-w-3xl">
            <p className="text-4xl mb-4">✨</p>
            <p className="text-2xl font-semibold text-foreground mb-1 line-clamp-3">{activeThread.title}</p>
            <p className="text-sm">{t('thread.describeTask')}</p>
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

      {/* Floating TODO Panel (currently disabled) */}
      {/* <AnimatePresence>
        {currentSnapshot && !todoPanelDismissed && currentSnapshot.progress.completed < currentSnapshot.progress.total && (
          <TodoPanel
            todos={currentSnapshot.todos}
            progress={currentSnapshot.progress}
            onDismiss={() => setTodoPanelDismissed(true)}
          />
        )}
      </AnimatePresence> */}

      {/* Messages + Timeline */}
      <div className="flex-1 flex min-h-0 thread-container">
        {/* Messages column + input */}
        <div className="flex-1 flex flex-col min-h-0 min-w-0">
          <div className="flex-1 min-h-0 min-w-0 overflow-y-auto flex flex-col" ref={scrollViewportRef}>
          <div className="w-full mx-auto max-w-3xl min-w-[320px] space-y-4 py-4 mt-auto px-4">
            {loadingMore && (
              <div className="flex items-center justify-center py-3">
                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                <span className="ml-2 text-xs text-muted-foreground">
                  {t('thread.loadingOlder', 'Loading older messages\u2026')}
                </span>
              </div>
            )}
            {!hasMore && !loadingMore && activeThread.messages.length > 0 && (
              <div className="text-center py-2">
                <span className="text-xs text-muted-foreground">
                  {t('thread.beginningOfConversation', 'Beginning of conversation')}
                  {activeThread.createdAt && (
                    <> &middot; {timeAgo(activeThread.createdAt, t)}</>
                  )}
                </span>
              </div>
            )}
            {activeThread.initInfo && (
              <InitInfoCard initInfo={activeThread.initInfo} />
            )}

            <MemoizedMessageList
              messages={activeThread.messages ?? []}
              threadId={activeThread.id}
              knownIds={knownIdsRef.current}
              prefersReducedMotion={prefersReducedMotion}
              snapshotMap={snapshotMap}
              onSend={handleSend}
              onOpenLightbox={openLightbox}
            />

            {isRunning && !isExternal && (
              <motion.div
                initial={prefersReducedMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, ease: 'easeOut' }}
                className="flex items-center gap-2.5 text-muted-foreground text-sm py-1"
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
                className="flex items-center gap-2.5 text-muted-foreground text-sm py-1"
              >
                <div className="flex items-center gap-1">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-[thinking_1.4s_ease-in-out_infinite]" />
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-[thinking_1.4s_ease-in-out_0.2s_infinite]" />
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-muted-foreground/60 animate-[thinking_1.4s_ease-in-out_0.4s_infinite]" />
                </div>
                <span className="text-xs">{t('thread.runningExternally', 'Running externally\u2026')}</span>
              </motion.div>
            )}

            {activeThread.status === 'waiting' && activeThread.waitingReason === 'question' && (
              <motion.div
                initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
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
                initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
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

            {activeThread.status === 'waiting' && !activeThread.waitingReason && (
              <motion.div
                initial={prefersReducedMotion ? false : { opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: 'easeOut' }}
              >
                <WaitingActions
                  onSend={(text) => handleSend(text, { model: activeThread.model, mode: activeThread.permissionMode })}
                />
              </motion.div>
            )}

            {activeThread.resultInfo && !isRunning && activeThread.status !== 'stopped' && activeThread.status !== 'interrupted' && (
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
                  onContinue={activeThread.resultInfo.status === 'failed' ? () => handleSend('Continue', { model: activeThread.model, mode: activeThread.permissionMode }) : undefined}
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
                  onContinue={() => handleSend('Continue', { model: activeThread.model, mode: activeThread.permissionMode })}
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
                  onContinue={() => handleSend('Continue', { model: activeThread.model, mode: activeThread.permissionMode })}
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
                  className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 flex items-center gap-1 rounded-full bg-secondary border border-muted-foreground/40 px-3 py-1.5 text-xs text-muted-foreground shadow-md hover:bg-muted transition-colors"
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
            activeMessageId={visibleMessageId ?? activeThread.messages.filter(m => m.role === 'user' && m.content?.trim()).at(-1)?.id}
            threadStatus={activeThread.status}
            messagesScrollRef={scrollViewportRef}
            onScrollToMessage={(msgId, toolCallId) => {
              // Try tool call element first, then user message
              const el = toolCallId
                ? scrollViewportRef.current?.querySelector(`[data-tool-call-id="${toolCallId}"]`)
                : scrollViewportRef.current?.querySelector(`[data-user-msg="${msgId}"]`);
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
