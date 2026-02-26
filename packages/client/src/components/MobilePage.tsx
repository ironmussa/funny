import type { Project } from '@funny/shared';
import { ArrowLeft, Plus, Folder, Loader2, ShieldQuestion } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Toaster } from '@/components/ui/sonner';
import { useWS } from '@/hooks/use-ws';
import { initAuth } from '@/lib/api';
import { api } from '@/lib/api';
import { resolveModelLabel } from '@/lib/thread-utils';
import { cn, TOAST_DURATION } from '@/lib/utils';
import { useAppStore } from '@/stores/app-store';
import { selectLastMessage } from '@/stores/thread-selectors';

import { PromptInput } from './PromptInput';
import { StatusBadge } from './StatusBadge';
import { AgentResultCard, AgentInterruptedCard } from './thread/AgentStatusCards';
import { MessageContent, CopyButton, WaitingActions } from './ThreadView';
import { ToolCallCard } from './ToolCallCard';

type MobileView =
  | { screen: 'projects' }
  | { screen: 'threads'; projectId: string }
  | { screen: 'chat'; projectId: string; threadId: string }
  | { screen: 'newThread'; projectId: string };

const D4C_FRAMES = ['🐇', '🌀', '🐰', '⭐'] as const;
const D4C_INTERVAL = 600;

const D4C_ANIMATIONS: Record<string, { initial: object; animate: object; exit: object }> = {
  '🐇': {
    initial: { y: 12, opacity: 0 },
    animate: { y: 0, opacity: 1 },
    exit: { y: -12, opacity: 0 },
  },
  '🌀': {
    initial: { rotate: -180, scale: 0.3, opacity: 0 },
    animate: { rotate: 0, scale: 1, opacity: 1 },
    exit: { rotate: 180, scale: 0.3, opacity: 0 },
  },
  '🐰': {
    initial: { y: 14, opacity: 0, scale: 0.8 },
    animate: { y: 0, opacity: 1, scale: 1 },
    exit: { y: -10, opacity: 0, scale: 0.8 },
  },
  '⭐': {
    initial: { scale: 0, opacity: 0 },
    animate: { scale: 1, opacity: 1 },
    exit: { scale: 0, opacity: 0 },
  },
};

function D4CAnimation() {
  const [frame, setFrame] = useState(0);
  const prefersReducedMotion = useReducedMotion();
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => (f + 1) % D4C_FRAMES.length), D4C_INTERVAL);
    return () => clearInterval(id);
  }, []);
  const emoji = D4C_FRAMES[frame];
  const anim = D4C_ANIMATIONS[emoji];
  return (
    <span className="inline-flex w-5 items-center justify-center overflow-hidden text-base leading-none">
      <AnimatePresence mode="wait">
        <motion.span
          key={emoji + frame}
          initial={prefersReducedMotion ? false : anim.initial}
          animate={anim.animate}
          exit={prefersReducedMotion ? undefined : anim.exit}
          transition={{ duration: 0.25, ease: 'easeOut' }}
          className="inline-block"
        >
          {emoji}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export function MobilePage() {
  const { t: _t } = useTranslation();
  const [view, setView] = useState<MobileView>({ screen: 'projects' });
  const [ready, setReady] = useState(false);

  const loadProjects = useAppStore((s) => s.loadProjects);
  const projects = useAppStore((s) => s.projects);

  // Connect WebSocket
  useWS();

  // Init auth + load projects on mount
  useEffect(() => {
    initAuth()
      .then(() => loadProjects())
      .finally(() => setReady(true));
  }, [loadProjects]);

  if (!ready) {
    return (
      <div className="flex h-[100dvh] items-center justify-center bg-background text-foreground">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <div className="flex h-[100dvh] flex-col overflow-hidden bg-background text-foreground">
        {view.screen === 'projects' && (
          <ProjectListView
            projects={projects}
            onSelect={(projectId) => setView({ screen: 'threads', projectId })}
          />
        )}
        {view.screen === 'threads' && (
          <ThreadListView
            projectId={view.projectId}
            onBack={() => setView({ screen: 'projects' })}
            onSelectThread={(threadId) =>
              setView({ screen: 'chat', projectId: view.projectId, threadId })
            }
            onNewThread={() => setView({ screen: 'newThread', projectId: view.projectId })}
          />
        )}
        {view.screen === 'newThread' && (
          <NewThreadView
            projectId={view.projectId}
            onBack={() => setView({ screen: 'threads', projectId: view.projectId })}
            onCreated={(threadId) =>
              setView({ screen: 'chat', projectId: view.projectId, threadId })
            }
          />
        )}
        {view.screen === 'chat' && (
          <ChatView
            projectId={view.projectId}
            threadId={view.threadId}
            onBack={() => setView({ screen: 'threads', projectId: view.projectId })}
          />
        )}
      </div>
      <Toaster position="top-center" duration={TOAST_DURATION} />
    </>
  );
}

// ── Project List ─────────────────────────────────────────────────

function ProjectListView({
  projects,
  onSelect,
}: {
  projects: Project[];
  onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();

  return (
    <>
      <header className="flex shrink-0 items-center border-b border-border px-4 py-3">
        <h1 className="text-base font-semibold">funny</h1>
      </header>
      <div className="flex-1 overflow-y-auto">
        {projects.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
            {t('sidebar.noProjects', 'No projects yet. Add one from the desktop app.')}
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {projects.map((project) => (
              <button
                key={project.id}
                onClick={() => onSelect(project.id)}
                className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors hover:bg-accent active:bg-accent/80"
              >
                <Folder className="h-5 w-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{project.name}</div>
                  <div className="truncate text-xs text-muted-foreground">{project.path}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ── Thread List ──────────────────────────────────────────────────

function ThreadListView({
  projectId,
  onBack,
  onSelectThread,
  onNewThread,
}: {
  projectId: string;
  onBack: () => void;
  onSelectThread: (threadId: string) => void;
  onNewThread: () => void;
}) {
  const { t } = useTranslation();
  const projects = useAppStore((s) => s.projects);
  const threadsByProject = useAppStore((s) => s.threadsByProject);
  const loadThreadsForProject = useAppStore((s) => s.loadThreadsForProject);

  const project = projects.find((p) => p.id === projectId);
  const threads = threadsByProject[projectId] ?? [];

  useEffect(() => {
    loadThreadsForProject(projectId);
  }, [projectId, loadThreadsForProject]);

  // Sort: running/waiting first, then by creation date descending
  const sortedThreads = [...threads]
    .filter((t) => !t.archived)
    .sort((a, b) => {
      const runningStatuses = ['running', 'waiting'];
      const aRunning = runningStatuses.includes(a.status) ? 0 : 1;
      const bRunning = runningStatuses.includes(b.status) ? 0 : 1;
      if (aRunning !== bRunning) return aRunning - bRunning;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <button
          onClick={onBack}
          aria-label={t('common.back', 'Back')}
          className="-ml-1 rounded p-1 hover:bg-accent"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="flex-1 truncate text-base font-semibold">{project?.name ?? 'Project'}</h1>
        <button
          onClick={onNewThread}
          className="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground active:bg-primary/80"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('sidebar.newThread', 'New')}
        </button>
      </header>
      <div className="flex-1 overflow-y-auto">
        {sortedThreads.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4 text-sm text-muted-foreground">
            {t('sidebar.noThreads', 'No threads yet. Create one to start.')}
          </div>
        ) : (
          <div className="space-y-1 p-2">
            {sortedThreads.map((thread) => (
              <button
                key={thread.id}
                onClick={() => onSelectThread(thread.id)}
                className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left transition-colors hover:bg-accent active:bg-accent/80"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium">{thread.title}</div>
                  <div className="mt-0.5 text-xs text-muted-foreground">
                    {new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(
                      new Date(thread.createdAt),
                    )}
                  </div>
                </div>
                <StatusBadge status={thread.status} />
              </button>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

// ── New Thread ────────────────────────────────────────────────────

function NewThreadView({
  projectId,
  onBack,
  onCreated,
}: {
  projectId: string;
  onBack: () => void;
  onCreated: (threadId: string) => void;
}) {
  const { t } = useTranslation();
  const loadThreadsForProject = useAppStore((s) => s.loadThreadsForProject);
  const projects = useAppStore((s) => s.projects);
  const project = projects.find((p) => p.id === projectId);
  const defaultThreadMode = project?.defaultMode ?? 'worktree';
  const [creating, setCreating] = useState(false);

  const handleCreate = async (
    prompt: string,
    opts: { model: string; mode: string; threadMode?: string; baseBranch?: string },
    images?: any[],
  ): Promise<boolean> => {
    if (creating) return false;
    setCreating(true);

    const result = await api.createThread({
      projectId,
      title: prompt.slice(0, 200),
      mode: (opts.threadMode as 'local' | 'worktree') || defaultThreadMode,
      model: opts.model,
      permissionMode: opts.mode,
      baseBranch: opts.baseBranch,
      prompt,
      images,
    });

    if (result.isErr()) {
      toast.error(result.error.message);
      setCreating(false);
      return false;
    }

    await loadThreadsForProject(projectId);
    onCreated(result.value.id);
    return true;
  };

  return (
    <>
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <button
          onClick={onBack}
          aria-label={t('common.back', 'Back')}
          className="-ml-1 rounded p-1 hover:bg-accent"
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-base font-semibold">{t('thread.newThread', 'New Thread')}</h1>
      </header>
      <div className="flex flex-1 items-center justify-center p-4 text-muted-foreground">
        <div className="text-center">
          <p className="mb-4 text-4xl">✨</p>
          <p className="text-2xl font-semibold text-foreground">{t('thread.whatShouldAgentDo')}</p>
          <p className="mt-2 text-sm">{t('thread.describeTask')}</p>
        </div>
      </div>
      <PromptInput
        onSubmit={handleCreate}
        loading={creating}
        isNewThread
        showBacklog
        projectId={projectId}
      />
    </>
  );
}

// ── Chat View ────────────────────────────────────────────────────

function ChatView({
  projectId: _projectId,
  threadId,
  onBack,
}: {
  projectId: string;
  threadId: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const selectThread = useAppStore((s) => s.selectThread);
  const activeThread = useAppStore((s) => s.activeThread);
  const [sending, setSending] = useState(false);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const userHasScrolledUp = useRef(false);
  const smoothScrollPending = useRef(false);

  // Select the thread on mount
  useEffect(() => {
    selectThread(threadId);
    return () => {
      selectThread(null);
    };
  }, [threadId, selectThread]);

  // Scroll tracking
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
    opts: { provider?: string; model: string; mode: string },
    images?: any[],
  ) => {
    if (!activeThread || sending) return;
    setSending(true);

    // Always scroll to bottom when the user sends a message (smooth)
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
      console.error('Send failed:', result.error);
    }
    setSending(false);
  };

  const handleStop = async () => {
    if (!activeThread) return;
    const result = await api.stopThread(activeThread.id);
    if (result.isErr()) {
      console.error('Stop failed:', result.error);
    }
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
          <ArrowLeft className="h-5 w-5" />
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
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
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
                  <ShieldQuestion className="h-3.5 w-3.5 animate-pulse" />
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
