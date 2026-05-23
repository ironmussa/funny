import { DEFAULT_FOLLOW_UP_MODE } from '@funny/shared/models';
import { useCallback, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import type { MessageStreamHandle } from '@/components/thread/MessageStream';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import {
  buildSendMessagePayload,
  type SendMessageOpts,
  type SendMessagePayload,
} from '@/lib/send-message-payload';
import { useProjectStore } from '@/stores/project-store';
import { useSettingsStore } from '@/stores/settings-store';
import type { ThreadCore } from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';

const log = createClientLogger('ThreadChatHandlers');

type ActiveThread = ThreadCore;

/**
 * Captured send opts while the follow-up dialog is open. We freeze the
 * already-resolved API payload here (including allowedTools/disallowedTools)
 * so a permission toggle between "Ask" and the user's answer doesn't change
 * what gets sent.
 */
export interface PendingSend {
  prompt: string;
  /** API-shape payload — already resolved through `buildSendMessagePayload`. */
  payload: SendMessagePayload;
  /** Original PromptInput-shape opts — needed for optimistic-message rendering. */
  rawOpts: SendOpts;
  images?: any[];
}

/** PromptInput-shape opts. `mode` here is the API's permissionMode. */
export interface SendOpts extends SendMessageOpts {
  model: string;
  mode: string;
}

interface Refs {
  activeThreadRef: RefObject<ActiveThread | null>;
  sendingRef: RefObject<boolean>;
  streamRef: RefObject<MessageStreamHandle | null>;
  pendingSendRef: RefObject<PendingSend | null>;
  setPromptRef: RefObject<((text: string) => void) | null>;
}

/**
 * Messaging-only logic for ThreadChatView: send, follow-up dialog, stop,
 * permission approval, tool respond. Fork / rewind / fork-and-rewind live
 * in `use-thread-checkpoints` (extracted for clarity; they share their own
 * in-flight guard).
 */
export function useThreadHandlers(refs: Refs) {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  const [followUpDialogOpen, setFollowUpDialogOpen] = useState(false);
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

      // Build the API payload once — used for the ask-dialog freeze and the
      // immediate send path so they can't drift.
      const toolPermissions = useSettingsStore.getState().toolPermissions;

      if (threadIsRunning && followUpMode === 'ask') {
        refs.pendingSendRef.current = {
          prompt,
          payload: buildSendMessagePayload(opts, toolPermissions),
          rawOpts: opts,
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
            opts.effort as any,
          );
      }
      requestAnimationFrame(() => refs.streamRef.current?.scrollToBottom());
      const payload = buildSendMessagePayload(opts, toolPermissions);
      const result = await api.sendMessage(thread.id, prompt, payload, images);
      handleSendResult(result, thread.id, { rollbackOnQueue: !threadIsRunning }, t);
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
      if (action === 'interrupt') {
        toast.info(t('thread.interruptingAgent'));
        useThreadStore
          .getState()
          .appendOptimisticMessage(
            thread.id,
            pending.prompt,
            pending.images,
            pending.rawOpts.model as any,
            pending.rawOpts.mode as any,
            pending.rawOpts.fileReferences,
            pending.rawOpts.effort as any,
          );
      }
      requestAnimationFrame(() => refs.streamRef.current?.scrollToBottom());
      const result = await api.sendMessage(
        thread.id,
        pending.prompt,
        { ...pending.payload, forceQueue: action === 'queue' ? true : undefined },
        pending.images,
      );
      handleSendResult(result, thread.id, { rollbackOnQueue: action === 'interrupt' }, t);
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
    if (result.isErr()) {
      log.error('stopThread failed', {
        threadId: thread.id,
        error: result.error.message,
      });
    }
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
      // Reuse the shared payload builder to derive allowedTools/disallowedTools.
      // Prompt/file/baseBranch are not used by approveTool — pass empties.
      const { allowedTools, disallowedTools } = buildSendMessagePayload(
        { model: '', mode: '' },
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
        log.error('approveTool failed', {
          threadId: thread.id,
          toolName,
          approved,
          error: result.error.message,
        });
      }
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

  return {
    sending,
    setSending: setSending as Dispatch<SetStateAction<boolean>>,
    followUpDialogOpen,
    setFollowUpDialogOpen,
    handleSend,
    handleFollowUpAction,
    handleFollowUpCancel,
    handleStop,
    handlePermissionApproval,
    handleToolRespond,
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

/**
 * Shared post-`sendMessage` handling.
 *
 * `rollbackOnQueue`:
 *   - true  → caller already appended an optimistic message under the
 *             assumption the request would run; if the server queued it
 *             instead, drop the optimistic bubble so the user doesn't see
 *             a phantom assistant reply.
 *   - false → no optimistic message to roll back (e.g. when the thread was
 *             already running — the bubble was never added).
 */
function handleSendResult(
  result: Awaited<ReturnType<typeof api.sendMessage>>,
  threadId: string,
  options: { rollbackOnQueue: boolean },
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
    if (options.rollbackOnQueue) {
      useThreadStore.getState().rollbackOptimisticMessage(threadId);
    }
    applyQueuedCount(threadId, (result.value as any).queuedCount);
    toast.success(t('thread.messageQueued'));
  }
}
