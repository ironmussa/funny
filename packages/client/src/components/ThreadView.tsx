import type { ThreadPurpose } from '@funny/shared';
import { DEFAULT_FOLLOW_UP_MODE } from '@funny/shared/models';
import { Loader2 } from 'lucide-react';
import { useReducedMotion } from 'motion/react';
import { useState, useRef, useEffect, useCallback, useMemo, startTransition } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { EMPTY_MESSAGES } from '@/components/thread/MemoizedMessageList';
import { MessageStream, type MessageStreamHandle } from '@/components/thread/MessageStream';
import { useMinuteTick } from '@/hooks/use-minute-tick';
import { useTodoSnapshots } from '@/hooks/use-todo-panel';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { buildPath } from '@/lib/url';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import {
  useActiveMessages,
  useActiveThreadEvents,
  useActiveCompactionEvents,
} from '@/stores/thread-selectors';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

const tvLog = createClientLogger('ThreadView');

import { FollowUpModeDialog } from './FollowUpModeDialog';
import { ImageLightbox } from './ImageLightbox';
import { PipelineProgressBanner } from './PipelineProgressBanner';
import { PromptInput } from './PromptInput';
import { NewThreadInput } from './thread/NewThreadInput';
import { ProjectHeader } from './thread/ProjectHeader';
import { PromptTimeline } from './thread/PromptTimeline';
import { ThreadSearchBar } from './thread/ThreadSearchBar';
import { WorktreeSetupProgress } from './WorktreeSetupProgress';

// Re-exports for backwards compatibility (used by MobilePage.tsx)
export { MessageContent, CopyButton } from '@/components/thread/MessageContent';
export { WaitingActions } from '@/components/thread/WaitingCards';

export function ThreadView() {
  const { t } = useTranslation();
  const navigate = useNavigate();
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
  const streamRef = useRef<MessageStreamHandle>(null);
  const [visibleMessageId, setVisibleMessageId] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxImages, setLightboxImages] = useState<{ src: string; alt: string }[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);
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

  // ── In-thread search (Ctrl+F) ───────────────────────────────────
  const [searchOpen, setSearchOpen] = useState(false);
  const highlightedMsgRef = useRef<string | null>(null);

  // Intercept Ctrl+F to open in-thread search instead of browser find
  useEffect(() => {
    if (!activeThread) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [activeThread]);

  /** Remove all injected <mark> highlights inside the scroll viewport */
  const clearSearchHighlights = useCallback(() => {
    const viewport = streamRef.current?.scrollViewport;
    if (!viewport) return;
    viewport.querySelectorAll('mark[data-search-hl]').forEach((mark) => {
      const parent = mark.parentNode;
      if (parent) {
        parent.replaceChild(document.createTextNode(mark.textContent || ''), mark);
        parent.normalize();
      }
    });
  }, []);

  /** Walk text nodes inside `root` and wrap matches of `query` with <mark> */
  const highlightTextInElement = useCallback((root: Element, query: string) => {
    if (!query) return;
    const queryLower = query.toLowerCase();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const matches: { node: Text; index: number }[] = [];

    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      const text = node.textContent || '';
      let idx = text.toLowerCase().indexOf(queryLower);
      while (idx !== -1) {
        matches.push({ node, index: idx });
        idx = text.toLowerCase().indexOf(queryLower, idx + queryLower.length);
      }
    }

    // Apply in reverse so indices stay valid
    for (let i = matches.length - 1; i >= 0; i--) {
      const { node: textNode, index } = matches[i];
      const after = textNode.splitText(index + queryLower.length);
      const matchNode = textNode.splitText(index);
      const mark = document.createElement('mark');
      mark.setAttribute('data-search-hl', '');
      mark.style.backgroundColor = '#FFE500';
      mark.style.color = 'black';
      mark.className = 'rounded-sm px-px font-semibold';
      mark.textContent = matchNode.textContent;
      matchNode.parentNode!.replaceChild(mark, matchNode);
      // `after` stays in place automatically
      void after;
    }
  }, []);

  const handleSearchNavigate = useCallback(
    (messageId: string, query: string) => {
      // Clear previous highlights
      clearSearchHighlights();

      highlightedMsgRef.current = messageId;

      // Expand render window if the message is hidden
      streamRef.current?.expandToItem(messageId);

      // Scroll to the message and highlight matching text
      const scrollToMsg = () => {
        const el = streamRef.current?.scrollViewport?.querySelector(
          `[data-item-key="${CSS.escape(messageId)}"]`,
        );
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          highlightTextInElement(el, query);
          // Scroll to first <mark> within the element for precision
          const firstMark = el.querySelector('mark[data-search-hl]');
          if (firstMark) {
            firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      };

      scrollToMsg();
      // Retry after a frame in case expandToItem needed to flush
      requestAnimationFrame(scrollToMsg);
    },
    [clearSearchHighlights, highlightTextInElement],
  );

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false);
    clearSearchHighlights();
    highlightedMsgRef.current = null;
  }, [clearSearchHighlights]);

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

  const openLightbox = useCallback((images: { src: string; alt: string }[], index: number) => {
    setLightboxImages(images);
    setLightboxIndex(index);
    setLightboxOpen(true);
  }, []);

  const handleToolRespond = useCallback((toolCallId: string, answer: string, _toolName: string) => {
    const thread = activeThreadRef.current;
    if (!thread) return;
    useThreadStore.getState().handleWSToolOutput(thread.id, { toolCallId, output: answer });
    api.updateToolCallOutput(thread.id, toolCallId, answer);
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
      const queuedCount = thread.queuedCount ?? 0;
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
      streamRef.current?.scrollToBottom();

      // Only show the optimistic message when the thread is NOT running.
      // When the thread is running, the message will be queued by the server
      // and displayed in the queue widget — showing an optimistic card would
      // cause a brief flash before the rollback removes it.
      // If the client is wrong about the thread being idle, the server may
      // queue the message and we'll roll it back; a rare flash is acceptable.
      if (!threadIsRunning) {
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
      }

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
        // Only roll back if we actually added an optimistic message (i.e. the
        // client thought the thread was idle but the server disagreed).
        if (!threadIsRunning) {
          useThreadStore.getState().rollbackOptimisticMessage(thread.id);
        }
        // Immediately update queuedCount from the API response so the queue
        // indicator appears without waiting for the WS event (which may be delayed).
        const responseQueuedCount = (result.value as any).queuedCount;
        tvLog.info('handleSend: message queued', {
          threadId: thread.id,
          responseQueuedCount: String(responseQueuedCount ?? 'undefined'),
          threadIsRunning: String(threadIsRunning),
        });
        if (typeof responseQueuedCount === 'number') {
          const current = useThreadStore.getState().activeThread;
          const { queuedCountByThread } = useThreadStore.getState();
          if (current?.id === thread.id) {
            useThreadStore.setState({
              activeThread: { ...current, queuedCount: responseQueuedCount },
              queuedCountByThread: { ...queuedCountByThread, [thread.id]: responseQueuedCount },
            });
            tvLog.info('handleSend: queuedCount set on activeThread', {
              threadId: thread.id,
              queuedCount: String(responseQueuedCount),
              activeThreadId: current.id,
            });
          } else {
            // Still persist to the map even if not the active thread
            useThreadStore.setState({
              queuedCountByThread: { ...queuedCountByThread, [thread.id]: responseQueuedCount },
            });
            tvLog.warn('handleSend: activeThread mismatch — queuedCount persisted to map', {
              threadId: thread.id,
              activeThreadId: current?.id ?? 'null',
            });
          }
        } else {
          tvLog.warn('handleSend: responseQueuedCount not a number', {
            threadId: thread.id,
            rawValue: JSON.stringify(result.value),
          });
        }
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

      streamRef.current?.scrollToBottom();

      // Only show the optimistic message for interrupt (the agent will restart
      // with this message). For queue, skip it — the message goes to the queue
      // widget and showing a card would cause a brief flash before rollback.
      if (action === 'interrupt') {
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
      }

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
        // Only roll back if we added an optimistic message (interrupt path)
        if (action === 'interrupt') {
          useThreadStore.getState().rollbackOptimisticMessage(thread.id);
        }
        // Immediately update queuedCount from the API response so the queue
        // indicator appears without waiting for the WS event (which may be delayed).
        const responseQueuedCount = (result.value as any).queuedCount;
        tvLog.info('handleFollowUpAction: message queued', {
          threadId: thread.id,
          action,
          responseQueuedCount: String(responseQueuedCount ?? 'undefined'),
        });
        if (typeof responseQueuedCount === 'number') {
          const current = useThreadStore.getState().activeThread;
          const { queuedCountByThread } = useThreadStore.getState();
          if (current?.id === thread.id) {
            useThreadStore.setState({
              activeThread: { ...current, queuedCount: responseQueuedCount },
              queuedCountByThread: { ...queuedCountByThread, [thread.id]: responseQueuedCount },
            });
          } else {
            useThreadStore.setState({
              queuedCountByThread: { ...queuedCountByThread, [thread.id]: responseQueuedCount },
            });
          }
        }
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

  const handlePhaseTransition = useCallback(
    async (newPurpose: ThreadPurpose) => {
      const thread = activeThreadRef.current;
      if (!thread?.arcId || newPurpose === thread.purpose) return;

      setSending(true);
      const { allowedTools, disallowedTools } = deriveToolLists(
        useSettingsStore.getState().toolPermissions,
      );

      const permissionMode = newPurpose === 'implement' ? 'autoEdit' : 'plan';
      const result = await api.createThread({
        projectId: thread.projectId,
        title: `${thread.title} [${newPurpose}]`,
        mode: newPurpose === 'implement' ? 'worktree' : 'local',
        provider: thread.provider,
        model: thread.model,
        permissionMode,
        baseBranch: thread.baseBranch || undefined,
        prompt: `Continue from the ${thread.purpose} phase. Read the arc artifacts and proceed with the ${newPurpose} phase.`,
        arcId: thread.arcId,
        purpose: newPurpose,
        allowedTools,
        disallowedTools,
      });

      setSending(false);

      if (result.isErr()) {
        toast.error(`Failed to create ${newPurpose} thread`);
        return;
      }

      useThreadStore.setState({ selectedThreadId: result.value.id });
      await useThreadStore.getState().loadThreadsForProject(thread.projectId);
      navigate(buildPath(`/projects/${thread.projectId}/threads/${result.value.id}`));
    },
    [navigate],
  );

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
          <Loader2 className="icon-lg animate-spin" />
        </div>
      </div>
    );
  }

  const uiQueuedCount = activeThread.queuedCount ?? 0;
  const isRunning = activeThread.status === 'running' || uiQueuedCount > 0;
  const isExternal = activeThread.provider === 'external';
  const isIdle = activeThread.status === 'idle' && uiQueuedCount === 0;

  // Debug: trace queuedCount at render time
  if (uiQueuedCount > 0) {
    tvLog.info('ThreadView render: queuedCount > 0', {
      threadId: activeThread.id,
      uiQueuedCount: String(uiQueuedCount),
      status: activeThread.status,
      isRunning: String(isRunning),
      isIdle: String(isIdle),
    });
  }
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
              onPhaseTransition={handlePhaseTransition}
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
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          {activeThread?.id && (
            <ThreadSearchBar
              threadId={activeThread.id}
              open={searchOpen}
              onClose={handleSearchClose}
              onNavigateToMessage={handleSearchNavigate}
            />
          )}
          <MessageStream
            ref={streamRef}
            threadId={activeThread.id}
            status={activeThread.status}
            messages={stableMessages ?? EMPTY_MESSAGES}
            threadEvents={stableThreadEvents}
            compactionEvents={stableCompactionEvents}
            initInfo={activeThread.initInfo}
            resultInfo={activeThread.resultInfo}
            waitingReason={activeThread.waitingReason}
            pendingPermission={activeThread.pendingPermission}
            isExternal={isExternal}
            model={activeThread.model}
            permissionMode={activeThread.permissionMode}
            onSend={handleSend}
            onPermissionApproval={handlePermissionApproval}
            onToolRespond={handleToolRespond}
            pagination={{
              hasMore,
              loadingMore,
              load: loadOlderMessages,
            }}
            createdAt={activeThread.createdAt}
            snapshotMap={snapshotMap}
            knownIds={knownIdsRef.current}
            onOpenLightbox={openLightbox}
            onVisibleMessageChange={setVisibleMessageId}
            prefersReducedMotion={prefersReducedMotion}
            footer={
              <PromptInput
                onSubmit={handleSend}
                onStop={handleStop}
                onPhaseTransition={handlePhaseTransition}
                loading={sending}
                running={isRunning && !isExternal}
                threadId={activeThread.id}
                isQueueMode={isQueueMode}
                queuedCount={activeThread.queuedCount ?? 0}
                queuedNextMessage={activeThread.queuedNextMessage}
                setPromptRef={setPromptRef}
                placeholder={t('thread.nextPrompt')}
              />
            }
          />
        </div>

        {/* Prompt Timeline — hidden when container < 600px */}
        {timelineVisible && activeThread.messages.length > 0 && (
          <PromptTimeline
            messages={activeThread.messages}
            activeMessageId={
              visibleMessageId ??
              activeThread.lastUserMessage?.id ??
              activeThread.messages.filter((m) => m.role === 'user' && m.content?.trim()).at(-1)?.id
            }
            threadStatus={activeThread.status}
            messagesScrollRef={{ current: streamRef.current?.scrollViewport ?? null }}
            onScrollToMessage={(msgId, toolCallId) => {
              const targetId = toolCallId || msgId;
              const selector = toolCallId
                ? `[data-tool-call-id="${toolCallId}"]`
                : `[data-user-msg="${msgId}"]`;
              const viewport = streamRef.current?.scrollViewport;
              const el = viewport?.querySelector(selector);
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              } else {
                // Item not rendered yet — expand window, then scroll after commit
                streamRef.current?.expandToItem(targetId);
                requestAnimationFrame(() => {
                  const el2 = streamRef.current?.scrollViewport?.querySelector(selector);
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
