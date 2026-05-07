import { ArrowLeft, Clock, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { D4CAnimation } from '@/components/D4CAnimation';
import { PromptInput } from '@/components/PromptInput';
import { StatusBadge } from '@/components/StatusBadge';
import { AgentInterruptedCard, AgentResultCard } from '@/components/thread/AgentStatusCards';
import { CopyButton, MessageContent } from '@/components/thread/MessageContent';
import { WaitingActions } from '@/components/thread/WaitingCards';
import { ToolCallCard } from '@/components/ToolCallCard';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { api } from '@/lib/api';
import { resolveModelLabel } from '@/lib/thread-utils';
import { cn } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';
import { useThreadSelector } from '@/stores/thread-context';
import { selectLastMessage } from '@/stores/thread-selectors';

interface Props {
  projectId: string;
  threadId: string;
  onBack: () => void;
}

export function ChatView({ projectId: _projectId, threadId, onBack }: Props) {
  const { t } = useTranslation();
  const selectThread = useAppStore((s) => s.selectThread);
  const activeThread = useThreadSelector((t) => t);
  const [sending, setSending] = useState(false);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const userHasScrolledUp = useRef(false);
  const smoothScrollPending = useRef(false);

  useEffect(() => {
    selectThread(threadId);
    return () => {
      selectThread(null);
    };
  }, [threadId, selectThread]);

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
    const handleScroll = () => {
      const { scrollTop, scrollHeight, clientHeight } = viewport;
      userHasScrolledUp.current = scrollHeight - scrollTop - clientHeight > 80;
    };
    viewport.addEventListener('scroll', handleScroll, { passive: true });
    return () => viewport.removeEventListener('scroll', handleScroll);
  }, []);

  useEffect(() => {
    const viewport = scrollViewportRef.current;
    if (!viewport) return;
    const scrollToBottom = () => {
      if (!userHasScrolledUp.current) {
        const { scrollTop, scrollHeight, clientHeight } = viewport;
        const actuallyAtBottom = scrollHeight - scrollTop - clientHeight <= 80;
        if (!actuallyAtBottom) {
          userHasScrolledUp.current = true;
          return;
        }
        if (smoothScrollPending.current) {
          smoothScrollPending.current = false;
          viewport.scrollTo({ top: viewport.scrollHeight, behavior: 'smooth' });
        } else {
          viewport.scrollTop = viewport.scrollHeight;
        }
      }
    };
    scrollToBottom();
    const observer = new MutationObserver(() => {
      requestAnimationFrame(scrollToBottom);
    });
    observer.observe(viewport, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    const timer = setTimeout(() => observer.disconnect(), 1500);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [scrollFingerprint]);

  const handleSend = async (
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
    if (!activeThread || sending) return;
    setSending(true);
    userHasScrolledUp.current = false;
    smoothScrollPending.current = true;
    useAppStore
      .getState()
      .appendOptimisticMessage(
        activeThread.id,
        prompt,
        images,
        opts.model as any,
        opts.mode as any,
        opts.fileReferences,
      );
    const result = await api.sendMessage(
      activeThread.id,
      prompt,
      {
        provider: opts.provider || undefined,
        model: opts.model || undefined,
        permissionMode: opts.mode || undefined,
      },
      images,
    );
    if (result.isErr()) {
      const err = result.error;
      toast.error(
        err.type === 'INTERNAL'
          ? t('thread.sendFailed')
          : t('thread.sendFailedGeneric', { error: err.message }),
      );
    }
    setSending(false);
  };

  const handleStop = async () => {
    if (!activeThread) return;
    const result = await api.stopThread(activeThread.id);
    if (result.isErr()) console.error('Stop failed:', result.error);
  };

  const isRunning = activeThread?.status === 'running';

  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <button
          onClick={onBack}
          aria-label={t('common.back', 'Back')}
          className="-ml-1 rounded p-1 hover:bg-accent"
        >
          <ArrowLeft className="icon-lg" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold">
            {activeThread?.title ?? t('thread.loading', 'Loading...')}
          </h1>
        </div>
        {activeThread && <StatusBadge status={activeThread.status} />}
      </header>

      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="icon-lg animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <ScrollArea className="flex-1 p-3" viewportRef={scrollViewportRef}>
            <div className="space-y-3">
              {activeThread.initInfo && (
                <div className="space-y-1 rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{t('initInfo.model')}</span>
                    <span className="font-mono">
                      {resolveModelLabel(activeThread.initInfo.model, t)}
                    </span>
                  </div>
                </div>
              )}

              {activeThread.messages?.flatMap((msg) => [
                msg.content && !msg.toolCalls?.some((tc: any) => tc.name === 'ExitPlanMode') && (
                  <div
                    key={msg.id}
                    className={cn(
                      'relative group rounded-lg px-3 py-2 text-sm w-fit max-w-full',
                      msg.role === 'user'
                        ? 'ml-auto bg-primary text-primary-foreground'
                        : 'bg-secondary text-secondary-foreground',
                    )}
                  >
                    {msg.role !== 'user' && (
                      <div className="mb-0.5 flex items-start gap-2">
                        <span className="flex-1 text-xs font-medium uppercase text-muted-foreground">
                          {msg.role}
                        </span>
                        <CopyButton content={msg.content} />
                      </div>
                    )}
                    {msg.images && msg.images.length > 0 && (
                      <div className="mb-2 flex flex-wrap gap-2">
                        {msg.images.map((img: any, idx: number) => (
                          <img
                            key={`attachment-${idx}`}
                            src={`data:${img.source.media_type};base64,${img.source.data}`}
                            alt={`Attachment ${idx + 1}`}
                            width={128}
                            height={128}
                            className="max-h-32 rounded border border-border"
                          />
                        ))}
                      </div>
                    )}
                    {msg.role === 'user' ? (
                      <>
                        <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs leading-relaxed">
                          {msg.content.trim()}
                        </pre>
                        {(msg.model || msg.permissionMode) && (
                          <div className="mt-1.5 flex gap-1">
                            {msg.model && (
                              <Badge
                                variant="outline"
                                className="h-4 border-primary-foreground/20 bg-primary-foreground/10 px-1.5 py-0 text-[10px] font-medium text-primary-foreground/70"
                              >
                                {resolveModelLabel(msg.model, t)}
                              </Badge>
                            )}
                            {msg.permissionMode && (
                              <Badge
                                variant="outline"
                                className="h-4 border-primary-foreground/20 bg-primary-foreground/10 px-1.5 py-0 text-[10px] font-medium text-primary-foreground/70"
                              >
                                {t(`prompt.${msg.permissionMode}`)}
                              </Badge>
                            )}
                          </div>
                        )}
                      </>
                    ) : (
                      <div className="overflow-x-auto break-words text-xs leading-relaxed">
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
                    planText={
                      tc.name === 'ExitPlanMode' && msg.content?.trim()
                        ? msg.content.trim()
                        : undefined
                    }
                    onRespond={
                      tc.name === 'AskUserQuestion' || tc.name === 'ExitPlanMode'
                        ? (answer: string) => handleSend(answer, { model: '', mode: '' })
                        : undefined
                    }
                  />
                )) ?? []),
              ])}

              {isRunning && (
                <div className="flex items-center gap-2.5 py-1 text-sm text-muted-foreground">
                  <D4CAnimation />
                  <span className="text-xs">{t('thread.agentWorking')}</span>
                </div>
              )}

              {activeThread.status === 'waiting' && activeThread.waitingReason === 'question' && (
                <div className="flex items-center gap-2 text-xs text-status-warning/80">
                  <Clock className="h-3.5 w-3.5 animate-pulse text-yellow-400" />
                  {t('thread.waitingForResponse')}
                </div>
              )}

              {activeThread.status === 'waiting' &&
                activeThread.waitingReason !== 'question' &&
                activeThread.waitingReason !== 'plan' && (
                  <WaitingActions onSend={(text) => handleSend(text, { model: '', mode: '' })} />
                )}

              {activeThread.resultInfo &&
                !isRunning &&
                activeThread.status !== 'stopped' &&
                activeThread.status !== 'interrupted' && (
                  <AgentResultCard
                    status={activeThread.resultInfo.status}
                    cost={activeThread.resultInfo.cost}
                    duration={activeThread.resultInfo.duration}
                    onContinue={
                      activeThread.resultInfo.status === 'failed'
                        ? () => handleSend('Continue', { model: '', mode: '' })
                        : undefined
                    }
                  />
                )}

              {activeThread.status === 'interrupted' && (
                <AgentInterruptedCard
                  onContinue={() => handleSend('Continue', { model: '', mode: '' })}
                />
              )}
            </div>
          </ScrollArea>

          <PromptInput
            onSubmit={handleSend}
            onStop={handleStop}
            loading={sending}
            running={isRunning}
            placeholder={t('thread.nextPrompt')}
          />
        </>
      )}
    </>
  );
}
