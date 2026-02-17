import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/app-store';
import { useSettingsStore } from '@/stores/settings-store';
import { useWS } from '@/hooks/use-ws';
import { initAuth } from '@/lib/api';
import { api } from '@/lib/api';
import { cn, TOAST_DURATION } from '@/lib/utils';
import { toast } from 'sonner';
import { Toaster } from 'sonner';
import {
  ArrowLeft,
  Plus,
  Folder,
  Loader2,
  Clock,
  Copy,
  Check,
  Send,
  CheckCircle2,
  XCircle,
  ShieldQuestion,
} from 'lucide-react';
import { PromptInput } from './PromptInput';
import { ToolCallCard } from './ToolCallCard';
import { StatusBadge } from './StatusBadge';
import { MessageContent, CopyButton, WaitingActions } from './ThreadView';
import { AgentResultCard, AgentInterruptedCard } from './thread/AgentStatusCards';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import type { Project, Thread } from '@funny/shared';

type MobileView =
  | { screen: 'projects' }
  | { screen: 'threads'; projectId: string }
  | { screen: 'chat'; projectId: string; threadId: string }
  | { screen: 'newThread'; projectId: string };

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

export function MobilePage() {
  const { t } = useTranslation();
  const [view, setView] = useState<MobileView>({ screen: 'projects' });
  const [ready, setReady] = useState(false);

  const loadProjects = useAppStore(s => s.loadProjects);
  const projects = useAppStore(s => s.projects);

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
      <div className="h-[100dvh] flex items-center justify-center bg-background text-foreground">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <div className="h-[100dvh] flex flex-col bg-background text-foreground overflow-hidden">
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
            onNewThread={() =>
              setView({ screen: 'newThread', projectId: view.projectId })
            }
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
      <Toaster position="top-center" theme="dark" duration={TOAST_DURATION} />
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
      <header className="flex items-center px-4 py-3 border-b border-border shrink-0">
        <h1 className="text-base font-semibold">funny</h1>
      </header>
      <div className="flex-1 overflow-y-auto">
        {projects.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm p-4">
            {t('sidebar.noProjects', 'No projects yet. Add one from the desktop app.')}
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {projects.map((project) => (
              <button
                key={project.id}
                onClick={() => onSelect(project.id)}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left hover:bg-accent active:bg-accent/80 transition-colors"
              >
                <Folder className="h-5 w-5 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{project.name}</div>
                  <div className="text-xs text-muted-foreground truncate">{project.path}</div>
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
  const projects = useAppStore(s => s.projects);
  const threadsByProject = useAppStore(s => s.threadsByProject);
  const loadThreadsForProject = useAppStore(s => s.loadThreadsForProject);

  const project = projects.find(p => p.id === projectId);
  const threads = threadsByProject[projectId] ?? [];

  useEffect(() => {
    loadThreadsForProject(projectId);
  }, [projectId, loadThreadsForProject]);

  // Sort: running/waiting first, then by creation date descending
  const sortedThreads = [...threads]
    .filter(t => !t.archived)
    .sort((a, b) => {
      const runningStatuses = ['running', 'waiting'];
      const aRunning = runningStatuses.includes(a.status) ? 0 : 1;
      const bRunning = runningStatuses.includes(b.status) ? 0 : 1;
      if (aRunning !== bRunning) return aRunning - bRunning;
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    });

  return (
    <>
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <button onClick={onBack} className="p-1 -ml-1 rounded hover:bg-accent">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-base font-semibold truncate flex-1">
          {project?.name ?? 'Project'}
        </h1>
        <button
          onClick={onNewThread}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary text-primary-foreground active:bg-primary/80"
        >
          <Plus className="h-3.5 w-3.5" />
          {t('sidebar.newThread', 'New')}
        </button>
      </header>
      <div className="flex-1 overflow-y-auto">
        {sortedThreads.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm p-4">
            {t('sidebar.noThreads', 'No threads yet. Create one to start.')}
          </div>
        ) : (
          <div className="p-2 space-y-1">
            {sortedThreads.map((thread) => (
              <button
                key={thread.id}
                onClick={() => onSelectThread(thread.id)}
                className="w-full flex items-center gap-3 px-4 py-3 rounded-lg text-left hover:bg-accent active:bg-accent/80 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-medium truncate">{thread.title}</div>
                  <div className="text-xs text-muted-foreground mt-0.5">
                    {new Date(thread.createdAt).toLocaleDateString()}
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
  const loadThreadsForProject = useAppStore(s => s.loadThreadsForProject);
  const defaultThreadMode = useSettingsStore(s => s.defaultThreadMode);
  const [creating, setCreating] = useState(false);

  const handleCreate = async (
    prompt: string,
    opts: { model: string; mode: string; threadMode?: string; baseBranch?: string },
    images?: any[]
  ) => {
    if (creating) return;
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
      return;
    }

    await loadThreadsForProject(projectId);
    onCreated(result.value.id);
  };

  return (
    <>
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <button onClick={onBack} className="p-1 -ml-1 rounded hover:bg-accent">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="text-base font-semibold">{t('thread.newThread', 'New Thread')}</h1>
      </header>
      <div className="flex-1 flex items-center justify-center text-muted-foreground p-4">
        <div className="text-center">
          <p className="text-4xl mb-4">✨</p>
          <p className="text-2xl font-semibold text-foreground">{t('thread.whatShouldAgentDo')}</p>
          <p className="text-sm mt-2">{t('thread.describeTask')}</p>
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
  projectId,
  threadId,
  onBack,
}: {
  projectId: string;
  threadId: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const selectThread = useAppStore(s => s.selectThread);
  const activeThread = useAppStore(s => s.activeThread);
  const [sending, setSending] = useState(false);
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const userHasScrolledUp = useRef(false);

  // Select the thread on mount
  useEffect(() => {
    selectThread(threadId);
    return () => {
      selectThread(null);
    };
  }, [threadId, selectThread]);

  // Scroll tracking
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
        viewport.scrollTop = viewport.scrollHeight;
      }
    };

    scrollToBottom();

    const observer = new MutationObserver(() => {
      requestAnimationFrame(scrollToBottom);
    });
    observer.observe(viewport, { childList: true, subtree: true, attributes: true, characterData: true });

    const timer = setTimeout(() => observer.disconnect(), 1500);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [scrollFingerprint]);

  const handleSend = async (prompt: string, opts: { model: string; mode: string }, images?: any[]) => {
    if (!activeThread || sending) return;
    setSending(true);

    useAppStore.getState().appendOptimisticMessage(
      activeThread.id,
      prompt,
      images,
      opts.model as any,
      opts.mode as any
    );

    const result = await api.sendMessage(activeThread.id, prompt, { model: opts.model || undefined, permissionMode: opts.mode || undefined }, images);
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
      <header className="flex items-center gap-3 px-4 py-3 border-b border-border shrink-0">
        <button onClick={onBack} className="p-1 -ml-1 rounded hover:bg-accent">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="text-sm font-semibold truncate">
            {activeThread?.title ?? t('thread.loading', 'Loading...')}
          </h1>
        </div>
        {activeThread && <StatusBadge status={activeThread.status} />}
      </header>

      {!activeThread ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          <ScrollArea className="flex-1 p-3" viewportRef={scrollViewportRef}>
            <div className="space-y-3">
              {activeThread.initInfo && (
                <div className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{t('initInfo.model')}</span>
                    <span className="font-mono">{activeThread.initInfo.model}</span>
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
                      <div className="flex items-start gap-2 mb-0.5">
                        <span className="text-xs font-medium uppercase text-muted-foreground flex-1">
                          {msg.role}
                        </span>
                        <CopyButton content={msg.content} />
                      </div>
                    )}
                    {msg.images && msg.images.length > 0 && (
                      <div className="flex flex-wrap gap-2 mb-2">
                        {msg.images.map((img: any, idx: number) => (
                          <img
                            key={idx}
                            src={`data:${img.source.media_type};base64,${img.source.data}`}
                            alt={`Attachment ${idx + 1}`}
                            className="max-h-32 rounded border border-border"
                          />
                        ))}
                      </div>
                    )}
                    {msg.role === 'user' ? (
                      <>
                        <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed break-words overflow-x-auto">
                          {msg.content.trim()}
                        </pre>
                        {(msg.model || msg.permissionMode) && (
                          <div className="flex gap-1 mt-1.5">
                            {msg.model && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-medium bg-primary-foreground/10 text-primary-foreground/70 border-primary-foreground/20">
                                {t(`thread.model.${msg.model}`)}
                              </Badge>
                            )}
                            {msg.permissionMode && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0 h-4 font-medium bg-primary-foreground/10 text-primary-foreground/70 border-primary-foreground/20">
                                {t(`prompt.${msg.permissionMode}`)}
                              </Badge>
                            )}
                          </div>
                        )}
                      </>
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
                    onRespond={
                      (tc.name === 'AskUserQuestion' || tc.name === 'ExitPlanMode')
                        ? (answer: string) => handleSend(answer, { model: '', mode: '' })
                        : undefined
                    }
                  />
                )) ?? []),
              ])}

              {isRunning && (
                <div className="flex items-center gap-2.5 text-muted-foreground text-sm py-1">
                  <D4CAnimation />
                  <span className="text-xs">{t('thread.agentWorking')}</span>
                </div>
              )}

              {activeThread.status === 'waiting' && activeThread.waitingReason === 'question' && (
                <div className="flex items-center gap-2 text-status-warning/80 text-xs">
                  <ShieldQuestion className="h-3.5 w-3.5 animate-pulse" />
                  {t('thread.waitingForResponse')}
                </div>
              )}

              {activeThread.status === 'waiting' && activeThread.waitingReason !== 'question' && activeThread.waitingReason !== 'plan' && (
                <WaitingActions
                  onSend={(text) => handleSend(text, { model: '', mode: '' })}
                />
              )}

              {activeThread.resultInfo && !isRunning && activeThread.status !== 'stopped' && activeThread.status !== 'interrupted' && (
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
