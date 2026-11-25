/**
 * Optimistic send actions for the thread store: the local user bubble shown
 * before the server confirms a message, and undoing it when the send fails.
 */
import type { MessageRole, Thread } from '@funny/shared';
import { addReferencedEntries, stripReferencedContents } from '@funny/shared/attachments';

import { rememberPreSendState, takePreSendState } from './optimistic-run-state';
import { getProjectPath } from './store-bridge';
import { transitionThreadStatus } from './thread-machine-bridge';
import * as mutations from './thread-mutations';
import { patchThreadRow } from './thread-row-writes';
import type { ThreadState } from './thread-state';
import { OPTIMISTIC_MESSAGE_ID_PREFIX, dropLastUserMessage } from './thread-store-messages';
import type { Get, Set } from './thread-ws-handlers/shared';

type OptimisticActions = Pick<
  ThreadState,
  'appendOptimisticMessage' | 'revertOptimisticRun' | 'rollbackOptimisticMessage'
>;

export function createOptimisticActions(set: Set, get: Get): OptimisticActions {
  return {
    appendOptimisticMessage: (
      threadId,
      content,
      images,
      model,
      permissionMode,
      fileReferences,
      effort,
    ) => {
      // Operate on the unified payload map so this works from the right pane
      // AND from any live column — anywhere the thread is currently loaded.
      const entry = get().threadDataById[threadId];
      if (!entry) return;
      const pid = entry.projectId;

      const machineEvent = { type: 'START' as const };
      const newStatus = transitionThreadStatus(threadId, machineEvent, entry.status, entry.cost);
      rememberPreSendState(threadId, {
        status: entry.status,
        waitingReason: entry.waitingReason,
        pendingPermission: entry.pendingPermission,
        initialPrompt: entry.initialPrompt,
      });

      // Pre-populate initInfo so the card renders immediately instead of
      // waiting for the agent:init WebSocket event from the server.
      const initInfo =
        entry.initInfo ??
        (() => {
          const projectPath = getProjectPath(pid);
          const cwd = entry.worktreePath || projectPath || '';
          return { model: model || entry.model, cwd, tools: [] as string[] };
        })();

      // Path-only entries so chips render in the optimistic message, merged
      // into any block the prompt already carries (inline attachments).
      const messageContent = stripReferencedContents(
        addReferencedEntries(
          content,
          (fileReferences ?? []).map((ref) => ({ type: ref.type ?? 'file', path: ref.path })),
        ),
      );

      const newMessage = {
        id: `${OPTIMISTIC_MESSAGE_ID_PREFIX}${crypto.randomUUID()}`,
        threadId,
        role: 'user' as MessageRole,
        content: messageContent,
        images,
        timestamp: new Date().toISOString(),
        model,
        permissionMode,
        effort,
      };

      // For idle threads (backlog/planning), a draft user message already exists —
      // replace it instead of appending a duplicate.
      const existingDraftIdx =
        entry.status === 'idle' ? entry.messages.findIndex((m) => m.role === 'user') : -1;
      const nextMessages =
        existingDraftIdx >= 0
          ? entry.messages.map((m, i) => (i === existingDraftIdx ? newMessage : m))
          : entry.messages.concat(newMessage);

      // Row fields — every view, the detail view included, reads them from the
      // threads collection.
      patchThreadRow(threadId, (t) => ({
        ...t,
        status: newStatus,
        initialPrompt: undefined,
        permissionMode: permissionMode || t.permissionMode,
      }));
      set((state) => ({
        // Payload patch — also mirrors to activeThread when this is the
        // selected thread.
        ...mutations.applyThreadDataPatch(state, threadId, (t) => ({
          ...t,
          initInfo,
          status: newStatus,
          initialPrompt: undefined,
          waitingReason: undefined,
          pendingPermission: undefined,
          permissionMode: permissionMode || t.permissionMode,
          messages: nextMessages,
          lastUserMessage: newMessage,
        })),
      }));
    },

    revertOptimisticRun: (threadId) => {
      const before = takePreSendState(threadId);
      if (!before) return;
      // Only the optimistic mark is undone: a status that has moved on is kept.
      const undo = <T extends Thread>(t: T): T =>
        t.status === 'running'
          ? { ...t, status: before.status, initialPrompt: before.initialPrompt }
          : t;
      patchThreadRow(threadId, undo);
      set((state) =>
        mutations.applyThreadDataPatch(state, threadId, (t) =>
          t.status === 'running'
            ? {
                ...undo(t),
                waitingReason: before.waitingReason,
                pendingPermission: before.pendingPermission,
              }
            : t,
        ),
      );
    },

    rollbackOptimisticMessage: (threadId) => {
      set((state) => mutations.applyThreadDataPatch(state, threadId, dropLastUserMessage));
    },
  };
}
