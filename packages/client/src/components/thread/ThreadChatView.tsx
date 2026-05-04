import { DEFAULT_FOLLOW_UP_MODE } from '@funny/shared/models';
import { useReducedMotion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import { FollowUpModeDialog } from '@/components/FollowUpModeDialog';
import { ImageLightbox } from '@/components/ImageLightbox';
import { PipelineProgressBanner } from '@/components/PipelineProgressBanner';
import { PromptInput } from '@/components/PromptInput';
import { EMPTY_MESSAGES } from '@/components/thread/MemoizedMessageList';
import { MessageStream, type MessageStreamHandle } from '@/components/thread/MessageStream';
import { ProjectHeader } from '@/components/thread/ProjectHeader';
import { PromptTimeline } from '@/components/thread/PromptTimeline';
import { ThreadSearchBar } from '@/components/thread/ThreadSearchBar';
import { useTodoSnapshots } from '@/hooks/use-todo-panel';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { buildPath } from '@/lib/url';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore, deriveToolLists } from '@/stores/settings-store';
import {
  useActiveCompactionEvents,
  useActiveMessages,
  useActiveThreadEvents,
} from '@/stores/thread-selectors';
import { useThreadStore } from '@/stores/thread-store';
import { useUIStore } from '@/stores/ui-store';

const log = createClientLogger('ThreadChatView');

type ActiveThread = NonNullable<ReturnType<typeof useThreadStore.getState>['activeThread']>;

interface PendingSend {
  prompt: string;
  opts: {
    provider?: string;
    model?: string;
    permissionMode?: string;
    allowedTools?: string[];
    disallowedTools?: string[];
    fileReferences?: { path: string }[];
    symbolReferences?: {
      path: string;
      name: string;
      kind: string;
      line: number;
      endLine?: number;
    }[];
    baseBranch?: string;
  };
  images?: any[];
}

function useThreadSearch(
  activeThreadId: string | null,
  streamRef: RefObject<MessageStreamHandle | null>,
) {
  const [searchOpen, setSearchOpen] = useState(false);
  const highlightedMsgRef = useRef<string | null>(null);

  useEffect(() => {
    if (!activeThreadId) return;
    const handler = (e: KeyboardEvent) => {
      if (e.ctrlKey && !e.shiftKey && e.key === 'f') {
        e.preventDefault();
        e.stopPropagation();
        setSearchOpen(true);
        const input = document.querySelector<HTMLInputElement>(
          '[data-testid="thread-search-input"]',
        );
        if (input) requestAnimationFrame(() => input.focus());
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [activeThreadId]);

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
  }, [streamRef]);

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
      void after;
    }
  }, []);

  const handleSearchNavigate = useCallback(
    (messageId: string, query: string) => {
      clearSearchHighlights();
      highlightedMsgRef.current = messageId;
      streamRef.current?.expandToItem(messageId);

      const scrollToMsg = () => {
        const el = streamRef.current?.scrollViewport?.querySelector(
          `[data-item-key="${CSS.escape(messageId)}"]`,
        );
        if (el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
          highlightTextInElement(el, query);
          const firstMark = el.querySelector('mark[data-search-hl]');
          if (firstMark) {
            firstMark.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      };

      scrollToMsg();
      requestAnimationFrame(scrollToMsg);
    },
    [clearSearchHighlights, highlightTextInElement, streamRef],
  );

  const handleSearchClose = useCallback(() => {
    setSearchOpen(false);
    clearSearchHighlights();
    highlightedMsgRef.current = null;
  }, [clearSearchHighlights]);

  return { searchOpen, setSearchOpen, handleSearchNavigate, handleSearchClose };
}

interface Props {
  activeThread: ActiveThread;
}

export function ThreadChatView({ activeThread }: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const stableMessages = useActiveMessages();
  const stableThreadEvents = useActiveThreadEvents();
  const stableCompactionEvents = useActiveCompactionEvents();
  const timelineVisible = useUIStore((s) => s.timelineVisible);
  const loadOlderMessages = useThreadStore((s) => s.loadOlderMessages);
  const hasMore = activeThread.hasMore ?? false;
  const loadingMore = activeThread.loadingMore ?? false;
  const prefersReducedMotion = useReducedMotion();

  const [sending, setSending] = useState(false);
  const streamRef = useRef<MessageStreamHandle>(null);
  const [visibleMessageId, setVisibleMessageId] = useState<string | null>(null);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [lightboxImages, setLightboxImages] = useState<{ src: string; alt: string }[]>([]);
  const [lightboxIndex, setLightboxIndex] = useState(0);
  const [followUpDialogOpen, setFollowUpDialogOpen] = useState(false);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);

  const pendingSendRef = useRef<PendingSend | null>(null);
  const setPromptRef = useRef<((text: string) => void) | null>(null);
  const activeThreadRef = useRef(activeThread);
  activeThreadRef.current = activeThread;
  const sendingRef = useRef(sending);
  sendingRef.current = sending;

  // Track which message/tool-call IDs existed when the thread was loaded.
  const knownIdsRef = useRef<Set<string>>(new Set());
  const prevThreadIdRef = useRef<string | null>(null);
  if (activeThread.id !== prevThreadIdRef.current) {
    prevThreadIdRef.current = activeThread.id;
    const ids = new Set<string>();
    if (stableMessages) {
      for (const m of stableMessages) {
        ids.add(m.id);
        if (m.toolCalls) for (const tc of m.toolCalls) ids.add(tc.id);
      }
    }
    knownIdsRef.current = ids;
  }

  const snapshots = useTodoSnapshots();
  const snapshotMapRef = useRef(new Map<string, number>());
  const snapshotMap = useMemo(() => {
    const next = new Map<string, number>();
    snapshots.forEach((s, i) => next.set(s.toolCallId, i));
    const prev = snapshotMapRef.current;
    if (prev.size === next.size && [...next].every(([k, v]) => prev.get(k) === v)) {
      return prev;
    }
    snapshotMapRef.current = next;
    return next;
  }, [snapshots]);

  const { searchOpen, handleSearchNavigate, handleSearchClose } = useThreadSearch(
    activeThread.id,
    streamRef,
  );

  const openLightbox = useCallback((images: { src: string; alt: string }[], index: number) => {
    setLightboxImages(images);
    setLightboxIndex(index);
    setLightboxOpen(true);
  }, []);

  const handleToolRespond = useCallback((toolCallId: string, answer: string) => {
    const thread = activeThreadRef.current;
    if (!thread) return;
    useThreadStore.getState().handleWSToolOutput(thread.id, { toolCallId, output: answer });
  }, []);

  const handleFork = useCallback(
    async (messageId: string) => {
      const thread = activeThreadRef.current;
      if (!thread || forkingMessageId) return;
      setForkingMessageId(messageId);
      try {
        const result = await api.forkThread(thread.id, messageId);
        if (result.isErr()) {
          log.error('Failed to fork thread', {
            threadId: thread.id,
            messageId,
            error: result.error.message,
          });
          toast.error(t('thread.forkFailed', 'Failed to fork conversation'));
          return;
        }
        const newThread = result.value;
        useThreadStore.setState({ selectedThreadId: newThread.id });
        await useThreadStore.getState().loadThreadsForProject(thread.projectId);
        navigate(buildPath(`/projects/${thread.projectId}/threads/${newThread.id}`));
        toast.success(t('thread.forkSuccess', 'Forked conversation'));
      } finally {
        setForkingMessageId(null);
      }
    },
    [forkingMessageId, navigate, t],
  );

  const handleStop = useCallback(async () => {
    const thread = activeThreadRef.current;
    if (!thread) return;
    const result = await api.stopThread(thread.id);
    if (result.isErr()) {
      console.error('Stop failed:', result.error);
    }
  }, []);

  const handlePermissionApproval = useCallback(
    async (toolName: string, approved: boolean, alwaysAllow?: boolean) => {
      const thread = activeThreadRef.current;
      if (!thread) return;
      const toolInput = thread.pendingPermission?.toolInput;
      useThreadStore
        .getState()
        .appendOptimisticMessage(
          thread.id,
          approved
            ? alwaysAllow
              ? `Always allowed: ${toolName}`
              : `Approved: ${toolName}`
            : `Denied: ${toolName}`,
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
        approved && alwaysAllow ? { scope: 'always', toolInput } : { scope: 'once' },
      );
      if (result.isErr()) {
        console.error('Permission approval failed:', result.error);
      }
    },
    [],
  );

  const handleSend = useSendMessage({
    activeThreadRef,
    sendingRef,
    setSending,
    streamRef,
    pendingSendRef,
    setFollowUpDialogOpen,
  });

  const handleFollowUpAction = useCallback(
    async (action: 'interrupt' | 'queue') => {
      setFollowUpDialogOpen(false);
      const pending = pendingSendRef.current;
      if (!pending) return;
      pendingSendRef.current = null;
      const thread = activeThreadRef.current;
      if (!thread) return;
      setSending(true);
      if (action === 'interrupt') toast.info(t('thread.interruptingAgent'));
      if (action === 'interrupt') {
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
      }
      requestAnimationFrame(() => streamRef.current?.scrollToBottom());
      const result = await api.sendMessage(
        thread.id,
        pending.prompt,
        { ...pending.opts, forceQueue: action === 'queue' ? true : undefined },
        pending.images,
      );
      if (result.isErr()) {
        const err = result.error;
        toast.error(
          err.type === 'INTERNAL'
            ? t('thread.sendFailed')
            : t('thread.sendFailedGeneric', { error: err.message }),
        );
      } else if (result.value && (result.value as any).queued) {
        if (action === 'interrupt') {
          useThreadStore.getState().rollbackOptimisticMessage(thread.id);
        }
        applyQueuedCount(thread.id, (result.value as any).queuedCount);
        toast.success(t('thread.messageQueued'));
      }
      setSending(false);
    },
    [t],
  );

  const handleFollowUpCancel = useCallback(() => {
    setFollowUpDialogOpen(false);
    const pending = pendingSendRef.current;
    if (pending && setPromptRef.current) setPromptRef.current(pending.prompt);
    pendingSendRef.current = null;
  }, []);

  const uiQueuedCount = activeThread.queuedCount ?? 0;
  const isRunning = activeThread.status === 'running' || uiQueuedCount > 0;
  const isExternal = activeThread.provider === 'external';
  const currentProject = useProjectStore
    .getState()
    .projects.find((p) => p.id === activeThread.projectId);
  const followUpMode = currentProject?.followUpMode || DEFAULT_FOLLOW_UP_MODE;
  const isQueueMode = followUpMode === 'queue' || followUpMode === 'ask';

  return (
    <div className="relative flex h-full min-w-0 flex-1 flex-col">
      <ProjectHeader />
      {activeThread.id && <PipelineProgressBanner threadId={activeThread.id} />}
      <div className="thread-container flex min-h-0 flex-1">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <ThreadSearchBar
            threadId={activeThread.id}
            open={searchOpen}
            onClose={handleSearchClose}
            onNavigateToMessage={handleSearchNavigate}
          />
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
            onFork={handleFork}
            forkingMessageId={forkingMessageId}
            pagination={{ hasMore, loadingMore, load: loadOlderMessages }}
            createdAt={activeThread.createdAt}
            snapshotMap={snapshotMap}
            knownIds={knownIdsRef.current}
            onOpenLightbox={openLightbox}
            onVisibleMessageChange={setVisibleMessageId}
            prefersReducedMotion={prefersReducedMotion}
            footer={
              activeThread.waitingReason === 'plan' ? null : (
                <PromptInput
                  onSubmit={handleSend}
                  onStop={handleStop}
                  loading={sending}
                  running={isRunning && !isExternal}
                  threadId={activeThread.id}
                  isQueueMode={isQueueMode}
                  queuedCount={activeThread.queuedCount ?? 0}
                  queuedNextMessage={activeThread.queuedNextMessage}
                  setPromptRef={setPromptRef}
                  placeholder={t('thread.nextPrompt')}
                />
              )
            }
          />
        </div>
        {timelineVisible && stableMessages && stableMessages.length > 0 && (
          <PromptTimeline
            messages={stableMessages}
            activeMessageId={
              visibleMessageId ??
              activeThread.lastUserMessage?.id ??
              stableMessages.filter((m) => m.role === 'user' && m.content?.trim()).at(-1)?.id
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
      <ImageLightbox
        images={lightboxImages}
        initialIndex={lightboxIndex}
        open={lightboxOpen}
        onClose={() => setLightboxOpen(false)}
      />
      <FollowUpModeDialog
        open={followUpDialogOpen}
        onInterrupt={() => handleFollowUpAction('interrupt')}
        onQueue={() => handleFollowUpAction('queue')}
        onCancel={handleFollowUpCancel}
      />
    </div>
  );
}

function applyQueuedCount(threadId: string, responseQueuedCount: unknown) {
  if (typeof responseQueuedCount !== 'number') return;
  const current = useThreadStore.getState().activeThread;
  const { queuedCountByThread } = useThreadStore.getState();
  if (current?.id === threadId) {
    useThreadStore.setState({
      activeThread: { ...current, queuedCount: responseQueuedCount },
      queuedCountByThread: { ...queuedCountByThread, [threadId]: responseQueuedCount },
    });
  } else {
    useThreadStore.setState({
      queuedCountByThread: { ...queuedCountByThread, [threadId]: responseQueuedCount },
    });
  }
}

function useSendMessage({
  activeThreadRef,
  sendingRef,
  setSending,
  streamRef,
  pendingSendRef,
  setFollowUpDialogOpen,
}: {
  activeThreadRef: RefObject<ActiveThread | null>;
  sendingRef: RefObject<boolean>;
  setSending: (v: boolean) => void;
  streamRef: RefObject<MessageStreamHandle | null>;
  pendingSendRef: RefObject<PendingSend | null>;
  setFollowUpDialogOpen: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  return useCallback(
    async (
      prompt: string,
      opts: {
        provider?: string;
        model: string;
        mode: string;
        effort?: string;
        fileReferences?: { path: string; type?: 'file' | 'folder' }[];
        symbolReferences?: {
          path: string;
          name: string;
          kind: string;
          line: number;
          endLine?: number;
        }[];
        baseBranch?: string;
      },
      images?: any[],
    ) => {
      if (sendingRef.current) {
        log.warn('handleSend: blocked by sendingRef', { promptPreview: prompt.slice(0, 80) });
        return;
      }
      const thread = activeThreadRef.current;
      if (!thread) return;
      const queuedCount = thread.queuedCount ?? 0;
      const threadIsRunning = thread.status === 'running' || queuedCount > 0;
      const currentProject = useProjectStore
        .getState()
        .projects.find((p) => p.id === thread.projectId);
      const followUpMode = currentProject?.followUpMode || DEFAULT_FOLLOW_UP_MODE;

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
            symbolReferences: opts.symbolReferences,
            baseBranch: opts.baseBranch,
          },
          images,
        };
        setFollowUpDialogOpen(true);
        return;
      }

      setSending(true);
      if (threadIsRunning && followUpMode === 'interrupt') {
        toast.info(t('thread.interruptingAgent'));
      }
      if (!threadIsRunning) {
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
      }
      requestAnimationFrame(() => streamRef.current?.scrollToBottom());
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
          effort: opts.effort || undefined,
          allowedTools,
          disallowedTools,
          fileReferences: opts.fileReferences,
          symbolReferences: opts.symbolReferences,
          baseBranch: opts.baseBranch,
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
      } else if (result.value && (result.value as any).queued) {
        if (!threadIsRunning) {
          useThreadStore.getState().rollbackOptimisticMessage(thread.id);
        }
        applyQueuedCount(thread.id, (result.value as any).queuedCount);
        toast.success(t('thread.messageQueued'));
      }
      setSending(false);
    },
    [activeThreadRef, sendingRef, setSending, streamRef, pendingSendRef, setFollowUpDialogOpen, t],
  );
}
