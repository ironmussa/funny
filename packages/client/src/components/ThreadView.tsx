import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAppStore } from '@/stores/app-store';
import { cn } from '@/lib/utils';
import { Loader2, Clock, Copy, Check, Send, CheckCircle2, XCircle, ArrowDown } from 'lucide-react';
import { api } from '@/lib/api';
import { PromptInput } from './PromptInput';
import { ToolCallCard } from './ToolCallCard';
import { ImageLightbox } from './ImageLightbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ProjectHeader } from './thread/ProjectHeader';
import { NewThreadInput } from './thread/NewThreadInput';
import { AgentResultCard, AgentInterruptedCard } from './thread/AgentStatusCards';

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
      ? <code className={cn('block bg-muted p-2 rounded text-xs overflow-x-auto', className)} {...props}>{children}</code>
      : <code className="bg-muted px-1 py-0.5 rounded text-xs" {...props}>{children}</code>;
  },
  pre: ({ children }: any) => <pre className="bg-muted rounded p-2 overflow-x-auto my-2">{children}</pre>,
};

const remarkPlugins = [remarkGfm];

const MessageContent = memo(function MessageContent({ content }: { content: string }) {
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

function CopyButton({ content }: { content: string }) {
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

function WaitingActions({ onSend }: { onSend: (text: string) => void }) {
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
    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 space-y-2.5">
      <div className="flex items-center gap-2 text-amber-400 text-xs">
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
      const isAtBottom = scrollHeight - scrollTop - clientHeight <= 80;
      userHasScrolledUp.current = !isAtBottom;
      setShowScrollDown(!isAtBottom);
    };

    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, []);

  // Scroll to bottom whenever the fingerprint changes (new messages, status changes).
  // Only scrolls if the user is already at the bottom (sticky behavior).
  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;

    if (!userHasScrolledUp.current) {
      viewport.scrollTop = viewport.scrollHeight;
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

  if (!selectedThreadId || !activeThread) {
    return (
      <div className="flex-1 flex flex-col h-full min-w-0">
        {selectedProjectId && <ProjectHeader />}
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center">
            <p className="text-sm">{t('thread.selectOrCreate')}</p>
            <p className="text-xs mt-1">{t('thread.threadsRunParallel')}</p>
          </div>
        </div>
      </div>
    );
  }

  const handleSend = async (prompt: string, opts: { model: string; mode: string }, images?: any[]) => {
    if (sending) return;
    setSending(true);

    useAppStore.getState().appendOptimisticMessage(activeThread.id, prompt, images);

    try {
      await api.sendMessage(activeThread.id, prompt, { model: opts.model || undefined, permissionMode: opts.mode || undefined }, images);
    } catch (e: any) {
      console.error('Send failed:', e);
    } finally {
      setSending(false);
    }
  };

  const handleStop = async () => {
    try {
      await api.stopThread(activeThread.id);
    } catch (e: any) {
      console.error('Stop failed:', e);
    }
  };

  const isRunning = activeThread.status === 'running';

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      <ProjectHeader />

      {/* Messages */}
      <ScrollArea className="flex-1 p-4" viewportRef={scrollViewportRef}>
        <div className="mx-auto w-1/2 min-w-[320px] max-w-full space-y-3 overflow-hidden">
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
                    <span key={tool} className="bg-secondary px-1.5 py-0.5 rounded text-[10px]">
                      {tool}
                    </span>
                  ))}
                </span>
              </div>
            </div>
          )}

          {activeThread.messages?.flatMap((msg) => [
              msg.content && (
                <div
                  key={msg.id}
                  className={cn(
                    'relative group rounded-lg px-3 py-2 text-sm w-fit max-w-full',
                    msg.role === 'user'
                      ? 'ml-auto bg-primary text-primary-foreground'
                      : 'bg-secondary text-secondary-foreground'
                  )}
                >
                  {msg.role !== 'user' && (
                    <CopyButton content={msg.content} />
                  )}
                  {msg.role !== 'user' && (
                    <span className="text-[10px] font-medium uppercase text-muted-foreground block mb-0.5">
                      {msg.role}
                    </span>
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
                    <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed break-words overflow-x-auto">
                      {msg.content.trim()}
                    </pre>
                  ) : (
                    <div className="text-xs leading-relaxed break-words overflow-x-auto">
                      <MessageContent content={msg.content.trim()} />
                    </div>
                  )}
                </div>
              ),
              ...(msg.toolCalls?.map((tc: any) => (
                <ToolCallCard
                  key={tc.id}
                  name={tc.name}
                  input={tc.input}
                  output={tc.output}
                  onRespond={(tc.name === 'AskUserQuestion' || tc.name === 'ExitPlanMode') ? (answer: string) => handleSend(answer, { model: '', mode: '' }) : undefined}
                />
              )) ?? []),
            ])}

          {isRunning && (
            <div className="flex items-center gap-2 text-muted-foreground text-xs">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t('thread.agentWorking')}
            </div>
          )}

          {activeThread.status === 'waiting' && activeThread.waitingReason !== 'question' && (
            <WaitingActions
              onSend={(text) => handleSend(text, { model: '', mode: '' })}
            />
          )}

          {activeThread.resultInfo && !isRunning && (
            <AgentResultCard
              status={activeThread.resultInfo.status}
              cost={activeThread.resultInfo.cost}
              duration={activeThread.resultInfo.duration}
            />
          )}

          {activeThread.status === 'interrupted' && (
            <AgentInterruptedCard
              onContinue={() => handleSend('Continue', { model: '', mode: '' })}
            />
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
