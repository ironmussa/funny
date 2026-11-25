import type { AgentModel, EffortLevel, PermissionDecision, PermissionMode } from '@funny/shared';
import { DEFAULT_FOLLOW_UP_MODE } from '@funny/shared/models';
import { useCallback, useRef, useState, type RefObject, type SetStateAction } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import type { MessageStreamHandle } from '@/components/thread/MessageStream';
import { readProject } from '@/data/projects/read';
import { applyQueueCount, readQueuedCount } from '@/data/queue/store';
import { api } from '@/lib/api';
import { createClientLogger } from '@/lib/client-logger';
import { buildSendMessagePayload, type SendMessageOpts } from '@/lib/send-message-payload';
import { startWorkflowInvocation } from '@/lib/start-workflow-invocation';
import { whilePending } from '@/lib/while-pending';
import { parseWorkflowInvocation } from '@/lib/workflow-invocation';
import { useSettingsStore } from '@/stores/settings-store';
import type { ThreadCore } from '@/stores/thread-context';
import { useThreadStore } from '@/stores/thread-store';

const log = createClientLogger('ThreadChatHandlers');

type ActiveThread = ThreadCore;

/** PromptInput-shape opts. `mode` here is the API's permissionMode. */
interface SendOpts extends SendMessageOpts {
  model: string;
  mode: string;
}

interface Refs {
  activeThreadRef: RefObject<ActiveThread | null>;
  sendingRef: RefObject<boolean>;
  streamRef: RefObject<MessageStreamHandle | null>;
}

function isUpdater(value: SetStateAction<boolean>): value is (prev: boolean) => boolean {
  return typeof value === 'function';
}

/** True for a number value. */
function isNumber(value: unknown): value is number {
  return typeof value === 'number';
}

/**
 * Messaging-only logic for ThreadChatView: send, stop, permission approval,
 * tool respond. Fork / rewind / fork-and-rewind live in
 * `use-thread-checkpoints` (extracted for clarity; they share their own
 * in-flight guard).
 */
export function useThreadHandlers(refs: Refs) {
  const { t } = useTranslation();
  const [sending, setSending] = useState(false);
  const inFlightRef = useRef(false);

  const setSendingSafely = useCallback((value: SetStateAction<boolean>) => {
    const next = isUpdater(value) ? value(inFlightRef.current) : value;
    inFlightRef.current = next;
    setSending(next);
  }, []);

  const handleSend = useCallback(
    async (prompt: string, opts: SendOpts, images?: any[]) => {
      if (inFlightRef.current) {
        log.warn('handleSend: blocked by sendingRef', { promptPreview: prompt.slice(0, 80) });
        return;
      }
      const thread = refs.activeThreadRef.current;
      if (!thread) return;
      const workflowParse = parseWorkflowInvocation(prompt);
      if (!workflowParse.ok) {
        toast.error(workflowParse.error);
        return false;
      }
      const invocation = workflowParse.invocation;
      if (invocation) {
        return whilePending(setSendingSafely, () =>
          startWorkflowInvocation(thread.id, invocation, opts, t),
        );
      }
      const queuedCount = readQueuedCount(thread.id);
      const threadIsRunning = thread.status === 'running' || queuedCount > 0;
      const currentProject = readProject(thread.projectId);
      const followUpMode = currentProject?.followUpMode || DEFAULT_FOLLOW_UP_MODE;

      const toolPermissions = useSettingsStore.getState().toolPermissions;

      return whilePending(setSendingSafely, async () => {
        if (threadIsRunning && followUpMode === 'interrupt') {
          toast.info(t('thread.interruptingAgent'));
        }
        if (threadIsRunning && followUpMode === 'steer') {
          toast.info(t('thread.steeringAgent'));
        }
        if (!threadIsRunning) {
          // SAFETY: these come from PromptInput's model, permission and effort selectors,
          // which only offer AgentModel, PermissionMode and EffortLevel values; the
          // submit options type them as plain strings.
          useThreadStore
            .getState()
            .appendOptimisticMessage(
              thread.id,
              prompt,
              images,
              opts.model as AgentModel,
              opts.mode as PermissionMode,
              opts.fileReferences,
              opts.effort as EffortLevel | undefined,
            );
        }
        requestAnimationFrame(() => refs.streamRef.current?.scrollToBottom());
        const payload = buildSendMessagePayload(opts, toolPermissions);
        const result = await api.sendMessage(thread.id, prompt, payload, images);
        handleSendResult(result, thread.id, { rollbackOnQueue: !threadIsRunning }, t);
      });
    },
    [refs, setSendingSafely, t],
  );

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
        // The answer did not reach the agent: show the request again.
        useThreadStore.getState().revertOptimisticRun(thread.id);
      }
    },
    [refs],
  );

  const handlePermissionDecision = useCallback(
    async (requestId: string, decision: PermissionDecision) => {
      const thread = refs.activeThreadRef.current;
      if (!thread) return;

      const result = await api.respondPermissionRequest(thread.id, requestId, decision);
      if (result.isErr()) {
        log.error('respondPermissionRequest failed', {
          threadId: thread.id,
          requestId,
          decision,
          error: result.error.message,
        });
        toast.error(result.error.message);
        // A 409 means the browser is looking at an old card. Reload the
        // server snapshot instead of sending a replacement prompt.
        if (result.error.type === 'CONFLICT') {
          await useThreadStore.getState().refreshActiveThread();
        }
        throw new Error(result.error.message);
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
    setSending: setSendingSafely,
    handleSend,
    handleStop,
    handlePermissionApproval,
    handlePermissionDecision,
    handleToolRespond,
  };
}

/** The response is JSON from the runner: apply the count only when it is a number. */
function applyQueuedCount(threadId: string, responseQueuedCount: number | undefined) {
  if (!isNumber(responseQueuedCount)) return;
  applyQueueCount(threadId, responseQueuedCount);
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
/**
 * A send failed: tell the user, and undo the `running` the optimistic message
 * put on the thread, since nothing started.
 */
export function reportSendFailure(
  err: { type: string; message: string },
  threadId: string,
  t: (key: string, opts?: { [option: string]: string | number }) => string,
  /** False when this send did not mark the thread running (it was already running). */
  undoOptimisticRun = true,
): void {
  toast.error(
    err.type === 'INTERNAL'
      ? t('thread.sendFailed')
      : t('thread.sendFailedGeneric', { error: err.message }),
  );
  if (undoOptimisticRun) useThreadStore.getState().revertOptimisticRun(threadId);
}

export function handleSendResult(
  result: Awaited<ReturnType<typeof api.sendMessage>>,
  threadId: string,
  options: { rollbackOnQueue: boolean },
  t: (key: string, opts?: { [option: string]: string | number }) => string,
) {
  if (result.isErr()) {
    reportSendFailure(result.error, threadId, t, options.rollbackOnQueue);
    return;
  }
  if (result.value?.queued) {
    if (options.rollbackOnQueue) {
      useThreadStore.getState().rollbackOptimisticMessage(threadId);
    }
    applyQueuedCount(threadId, result.value.queuedCount);
    toast.success(t('thread.messageQueued'));
    return;
  }
  if (result.value?.handledLocally === 'shell_escape' && options.rollbackOnQueue) {
    useThreadStore.getState().rollbackOptimisticMessage(threadId);
    // A shell escape runs no agent.
    useThreadStore.getState().revertOptimisticRun(threadId);
  }
}
