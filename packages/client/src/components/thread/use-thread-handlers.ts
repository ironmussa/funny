import { DEFAULT_FOLLOW_UP_MODE } from '@funny/shared/models';
import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import type { MessageStreamHandle } from '@/components/thread/MessageStream';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { buildPath } from '@/lib/url';
import { useProjectStore } from '@/stores/project-store';
import { deriveToolLists, useSettingsStore } from '@/stores/settings-store';
import type { ThreadCore } from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';

const log = createClientLogger('ThreadChatHandlers');

type ActiveThread = ThreadCore;

export interface PendingSend {
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

export interface SendOpts {
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
}

interface Refs {
  activeThreadRef: RefObject<ActiveThread | null>;
  sendingRef: RefObject<boolean>;
  streamRef: RefObject<MessageStreamHandle | null>;
  pendingSendRef: RefObject<PendingSend | null>;
  setPromptRef: RefObject<((text: string) => void) | null>;
}

/**
 * All non-search messaging logic for ThreadChatView: send, follow-up dialog,
 * stop, permission approval, tool respond, fork. Pulls api/sonner/settings-
 * store/buildPath/router/client-logger out of ThreadChatView's import graph.
 */
export function useThreadHandlers(refs: Refs) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [sending, setSending] = useState(false);
  const [followUpDialogOpen, setFollowUpDialogOpen] = useState(false);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  refs.sendingRef.current = sending;

  const handleSend = useCallback(
    async (prompt: string, opts: SendOpts, images?: any[]) => {
      if (refs.sendingRef.current) {
        log.warn('handleSend: blocked by sendingRef', { promptPreview: prompt.slice(0, 80) });
        return;
      }
      const thread = refs.activeThreadRef.current;
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
        refs.pendingSendRef.current = {
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
      requestAnimationFrame(() => refs.streamRef.current?.scrollToBottom());
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
      handleSendResult(result, thread.id, threadIsRunning, t);
      setSending(false);
    },
    [refs, t],
  );

  const handleFollowUpAction = useCallback(
    async (action: 'interrupt' | 'queue') => {
      setFollowUpDialogOpen(false);
      const pending = refs.pendingSendRef.current;
      if (!pending) return;
      refs.pendingSendRef.current = null;
      const thread = refs.activeThreadRef.current;
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
      requestAnimationFrame(() => refs.streamRef.current?.scrollToBottom());
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
    [refs, t],
  );

  const handleFollowUpCancel = useCallback(() => {
    setFollowUpDialogOpen(false);
    const pending = refs.pendingSendRef.current;
    if (pending && refs.setPromptRef.current) refs.setPromptRef.current(pending.prompt);
    refs.pendingSendRef.current = null;
  }, [refs]);

  const handleStop = useCallback(async () => {
    const thread = refs.activeThreadRef.current;
    if (!thread) return;
    const result = await api.stopThread(thread.id);
    if (result.isErr()) console.error('Stop failed:', result.error);
  }, [refs]);

  const handlePermissionApproval = useCallback(
    async (toolName: string, approved: boolean, alwaysAllow?: boolean) => {
      const thread = refs.activeThreadRef.current;
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
      if (result.isErr()) console.error('Permission approval failed:', result.error);
    },
    [refs],
  );

  const handleToolRespond = useCallback(
    (toolCallId: string, answer: string) => {
      const thread = refs.activeThreadRef.current;
      if (!thread) return;
      useThreadStore.getState().handleWSToolOutput(thread.id, { toolCallId, output: answer });
    },
    [refs],
  );

  const handleFork = useCallback(
    async (messageId: string) => {
      const thread = refs.activeThreadRef.current;
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
    [forkingMessageId, navigate, refs, t],
  );

  return {
    sending,
    setSending: setSending as Dispatch<SetStateAction<boolean>>,
    followUpDialogOpen,
    setFollowUpDialogOpen,
    forkingMessageId,
    handleSend,
    handleFollowUpAction,
    handleFollowUpCancel,
    handleStop,
    handlePermissionApproval,
    handleToolRespond,
    handleFork,
  };
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

function handleSendResult(
  result: Awaited<ReturnType<typeof api.sendMessage>>,
  threadId: string,
  threadIsRunning: boolean,
  t: (key: string, opts?: Record<string, unknown>) => string,
) {
  if (result.isErr()) {
    const err = result.error;
    toast.error(
      err.type === 'INTERNAL'
        ? t('thread.sendFailed')
        : t('thread.sendFailedGeneric', { error: err.message }),
    );
    return;
  }
  if (result.value && (result.value as any).queued) {
    if (!threadIsRunning) {
      useThreadStore.getState().rollbackOptimisticMessage(threadId);
    }
    applyQueuedCount(threadId, (result.value as any).queuedCount);
    toast.success(t('thread.messageQueued'));
  }
}
