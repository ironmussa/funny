/**
 * Board actions for the thread store: archive, rename, pin, stage moves,
 * permission mode and deletes. Row writes are optimistic transactions on the
 * threads collection (see data/threads/actions.ts).
 */
import {
  archiveThread as archiveThreadRow,
  deleteThread as deleteThreadRow,
  moveThreadStage,
  pinThread as pinThreadRow,
  renameThread as renameThreadRow,
  setThreadPermissionMode as setThreadPermissionModeRow,
  unarchiveThread as unarchiveThreadRow,
} from '@/data/threads/actions';
import { removeThreadLocally } from '@/data/threads/loaders';
import { readThreadRow } from '@/data/threads/read';
import { api } from '@/lib/api';
import { toastError } from '@/lib/toast-error';

import { deriveToolLists, useSettingsStore } from './settings-store';
import { cleanupThreadActor } from './thread-machine-bridge';
import * as mutations from './thread-mutations';
import type { ThreadState } from './thread-state';
import { forgetThread } from './thread-store-live-refs';
import { readActiveThreadView, readThreadView } from './thread-view';
import type { Get, Set } from './thread-ws-handlers/shared';

type BoardActions = Pick<
  ThreadState,
  | 'archiveThread'
  | 'unarchiveThread'
  | 'renameThread'
  | 'pinThread'
  | 'updateThreadStage'
  | 'updateThreadPermissionMode'
  | 'deleteThread'
  | 'deleteScratchThread'
  | 'handleShareRevoked'
  | 'handleThreadDeleted'
>;

function isAgentActive(threadId: string): boolean {
  const status = readThreadRow(threadId)?.status;
  return status === 'running' || status === 'waiting';
}

export function createBoardActions(set: Set, get: Get): BoardActions {
  return {
    // Board writes are optimistic transactions on the threads collection: they
    // never revert on a stale list response and roll back (with a toast) on
    // failure. See data/threads/actions.ts.
    archiveThread: async (threadId) => {
      const result = await archiveThreadRow(threadId);
      if (result.isOk()) cleanupThreadActor(threadId);
    },

    unarchiveThread: async (threadId, _projectId, stage) => {
      await unarchiveThreadRow(threadId, stage);
    },

    renameThread: async (threadId, _projectId, title) => {
      await renameThreadRow(threadId, title);
    },

    pinThread: async (threadId, _projectId, pinned) => {
      await pinThreadRow(threadId, pinned);
    },

    updateThreadStage: async (threadId, _projectId, stage) => {
      const row = readThreadRow(threadId);
      // Moving a never-started thread into In Progress starts it. The send
      // promotes the thread on the runner (stage + reuses its draft), so no
      // separate stage PATCH — that alone would leave it idle forever.
      if (stage === 'in_progress' && row?.status === 'idle' && row.initialPrompt) {
        const { allowedTools, disallowedTools } = deriveToolLists(
          useSettingsStore.getState().toolPermissions,
        );
        const result = await api.sendMessage(threadId, row.initialPrompt, {
          provider: row.provider,
          model: row.model,
          permissionMode: row.permissionMode,
          allowedTools,
          disallowedTools,
        });
        if (result.isErr()) toastError(result.error, 'startIdleThread');
        return;
      }
      await moveThreadStage(threadId, stage);
    },

    updateThreadPermissionMode: async (threadId, permissionMode) => {
      const current = get();
      const active = readActiveThreadView(current);
      const previousMode =
        readThreadView(current, threadId)?.permissionMode ??
        readThreadRow(threadId)?.permissionMode ??
        (active?.id === threadId ? active.permissionMode : undefined);
      if (!previousMode || previousMode === permissionMode) return true;

      // The row write is an optimistic transaction (rolls back with a toast on
      // failure); the loaded payload is patched alongside it.
      const patchPayload = (mode: typeof permissionMode) =>
        set((state) =>
          mutations.applyThreadDataPatch(state, threadId, (thread) => ({
            ...thread,
            permissionMode: mode,
          })),
        );

      patchPayload(permissionMode);
      const result = await setThreadPermissionModeRow(threadId, permissionMode);
      if (result.isErr()) {
        patchPayload(previousMode);
        return false;
      }
      return true;
    },

    // Deletes are optimistic: the row leaves every list at once and comes back
    // (with a toast) if the server refuses. Local payload/selection state is
    // dropped once the delete is confirmed.
    deleteThread: async (threadId, _projectId, options) => {
      const result = await deleteThreadRow(threadId, {
        stopFirst: isAgentActive(threadId),
        deleteBranch: options?.deleteBranch,
      });
      if (result.isOk()) forgetThread(get, set, threadId);
      return result.isOk();
    },

    deleteScratchThread: async (threadId) => {
      const result = await deleteThreadRow(threadId, { stopFirst: isAgentActive(threadId) });
      if (result.isOk()) forgetThread(get, set, threadId);
      return result.isOk();
    },

    handleShareRevoked: (threadId) => {
      removeThreadLocally(threadId);
      forgetThread(get, set, threadId);
    },

    handleThreadDeleted: (threadId) => {
      removeThreadLocally(threadId);
      forgetThread(get, set, threadId);
    },
  };
}
