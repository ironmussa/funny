/** `agent:status` and `thread:stage-changed`. */

import type {
  PendingPermissionRequest,
  PermissionApprovalCapability,
  PermissionRecoveryReason,
  Thread,
  ThreadStage,
} from '@funny/shared';

import { settlePreSendState } from '../optimistic-run-state';
import { useThreadActiveToolStore } from '../thread-active-tool-store';
import {
  invalidateThreadData,
  transitionThreadStatus,
  wsEventToMachineEvent,
} from '../thread-machine-bridge';
import * as mutations from '../thread-mutations';
import { useThreadReadStore } from '../thread-read-store';
import { getUrlThreadId } from '../thread-store-internals';
import {
  isHydrated,
  maybeBuffer,
  patchSidebarThread,
  scheduleProjectRefresh,
  terminalTimestamps,
  wsLog,
  type Get,
  type Set,
} from './shared';

// ── Status ──────────────────────────────────────────────────────

export function handleWSStatus(
  get: Get,
  set: Set,
  threadId: string,
  data: {
    status: string;
    waitingReason?: string;
    permissionRequest?: { toolName: string; toolInput?: string };
    pendingPermissionRequest?: PendingPermissionRequest;
    permissionApprovalCapability?: PermissionApprovalCapability;
    permissionRecoveryReason?: PermissionRecoveryReason;
    stage?: string;
    permissionMode?: string;
  },
): void {
  // The server has spoken about this thread's status: an optimistic
  // `running` from a send is no longer something to undo.
  settlePreSendState(threadId);
  // Buffer status events when thread is selected but not yet fully loaded.
  // Invalidate cache unconditionally so the active thread's snapshot reflects
  // the new status when the user navigates away and returns.
  invalidateThreadData(threadId);

  const state = get();
  if (!isHydrated(state, threadId)) {
    maybeBuffer(state, threadId, 'status', data);
    // Sidebar still gets the status update below.
  }

  if (data.status !== 'running') useThreadActiveToolStore.getState().clear(threadId);

  const machineEvent = wsEventToMachineEvent('agent:status', data);
  if (!machineEvent) {
    wsLog.warn('Invalid status transition', { threadId, status: data.status });
    return;
  }

  // Apply the status transition to whichever sidebar bucket holds the thread
  // (project or scratch). `patchSidebarThread` walks both and returns a
  // single partial state update for atomic application below.
  // `completedAt` this event wrote, so the open thread can be marked read at it.
  let endedAt: string | undefined;
  const foundInSidebar = patchSidebarThread(threadId, (t) => {
    const newStatus = transitionThreadStatus(threadId, machineEvent, t.status, t.cost);
    const statusTimestamps = newStatus === t.status ? {} : terminalTimestamps(newStatus);
    wsLog.debug('status transition', {
      threadId,
      from: t.status,
      to: newStatus,
      waitingReason: data.waitingReason ?? '',
    });
    if (
      newStatus === t.status &&
      (!data.stage || data.stage === t.stage) &&
      (!data.permissionMode || data.permissionMode === t.permissionMode)
    ) {
      return t;
    }
    endedAt = statusTimestamps.completedAt;
    return {
      ...t,
      status: newStatus,
      ...statusTimestamps,
      stage: data.stage ? (data.stage as any) : t.stage,
      permissionMode: data.permissionMode ? (data.permissionMode as any) : t.permissionMode,
    };
  });

  // Apply the same transition to the loaded payload (right pane / live column).
  const payloadPatch = mutations.applyThreadDataPatch(state, threadId, (t) => {
    const newStatus = transitionThreadStatus(threadId, machineEvent, t.status, t.cost);
    const statusChanged = newStatus !== t.status;
    const stageChanged = !!data.stage && data.stage !== t.stage;
    const permModeChanged = !!data.permissionMode && data.permissionMode !== t.permissionMode;
    const waitingReasonChanged =
      data.waitingReason !== undefined && data.waitingReason !== t.waitingReason;
    const permReqChanged = !!data.permissionRequest !== !!t.pendingPermission;
    const structuredPermReqChanged =
      data.pendingPermissionRequest !== undefined &&
      data.pendingPermissionRequest.requestId !== t.pendingPermissionRequest?.requestId;
    // Capabilities belong to a run. Non-Codex providers omit this field,
    // so starting another run must not inherit the previous Codex capability.
    const permissionApprovalCapability =
      data.permissionApprovalCapability ??
      (newStatus === 'running' && statusChanged ? undefined : t.permissionApprovalCapability);
    const permissionCapabilityChanged =
      JSON.stringify(permissionApprovalCapability) !==
      JSON.stringify(t.permissionApprovalCapability);
    const permissionRecoveryChanged = data.permissionRecoveryReason !== t.permissionRecoveryReason;
    if (
      !(
        statusChanged ||
        stageChanged ||
        permModeChanged ||
        waitingReasonChanged ||
        permReqChanged ||
        structuredPermReqChanged ||
        permissionCapabilityChanged ||
        permissionRecoveryChanged
      )
    ) {
      return t;
    }
    if (newStatus === 'waiting' && !data.waitingReason) {
      wsLog.warn('BUG-HUNT: agent:status waiting but NO waitingReason', {
        threadId,
        dataStatus: data.status,
      });
    }
    if (newStatus === 'waiting') {
      return {
        ...t,
        status: newStatus,
        waitingReason: data.waitingReason as any,
        pendingPermission: data.permissionRequest,
        // A permission wait is the only state that may retain a live ACP
        // continuation. Clearing it for every other wait prevents a resolved
        // request from resurfacing after a later question/provider pause.
        pendingPermissionRequest: data.pendingPermissionRequest,
        permissionApprovalCapability,
        permissionRecoveryReason: data.permissionRecoveryReason,
        stage: data.stage ? (data.stage as any) : t.stage,
        permissionMode: data.permissionMode ? (data.permissionMode as any) : t.permissionMode,
      };
    }
    return {
      ...t,
      status: newStatus,
      ...terminalTimestamps(newStatus),
      waitingReason: undefined,
      pendingPermission: undefined,
      pendingPermissionRequest: undefined,
      permissionRecoveryReason: undefined,
      permissionApprovalCapability,
      resultInfo: newStatus === 'stopped' || newStatus === 'interrupted' ? undefined : t.resultInfo,
      stage: data.stage ? (data.stage as any) : t.stage,
      permissionMode: data.permissionMode ? (data.permissionMode as any) : t.permissionMode,
    };
  });

  if (Object.keys(payloadPatch).length > 0) set(payloadPatch as any);

  // A run that ends by status alone (a stop emits `agent:status: stopped` with
  // no `agent:result`) bumps `completedAt`. If the user is looking at the
  // thread, it is read: otherwise the unread blue dot hides the stopped dot.
  if (endedAt && (getUrlThreadId() ?? state.selectedThreadId) === threadId) {
    useThreadReadStore.getState().markRead(threadId, endedAt);
  }

  if (!foundInSidebar) {
    const pid = state.threadDataById[threadId]?.projectId;
    if (pid) {
      scheduleProjectRefresh(get, pid);
    } else {
      // Thread not found in any loaded project — likely created externally
      // (e.g. Chrome extension ingest). Debounce refresh to avoid API storm.
      scheduleProjectRefresh(get);
    }
  }
}

// ── Stage changed ───────────────────────────────────────────────
//
// The server emits `thread:stage-changed` for EVERY stage transition —
// both user-driven (a Kanban drag, echoed back to all of the user's
// tabs) and server-driven (e.g. an agent finishing auto-transitions the
// thread from `in_progress` to `review`). Without a client handler the
// board only reflected the optimistic local drag and silently dropped
// every server-driven move, so a completed card stayed stranded in the
// "In Progress" column until a manual reload. This patches the same
// single source of truth as the other handlers so the board (and the
// right pane) stay live.
export function handleWSStageChanged(
  get: Get,
  set: Set,
  threadId: string,
  data: {
    fromStage: ThreadStage | null;
    toStage: ThreadStage;
    projectId: string;
  },
): void {
  const toStage = data.toStage;
  // The Kanban derives a card's column from `archived ? 'archived' : stage`.
  // Keep both fields consistent: archiving flips the flag; any other target
  // both clears `archived` (un-archive) and sets the new stage.
  const apply = <T extends Thread>(t: T): T => {
    if (toStage === 'archived') {
      return t.archived ? t : { ...t, archived: true };
    }
    if (t.archived || t.stage !== toStage) {
      return { ...t, archived: false, stage: toStage };
    }
    return t;
  };

  const found = patchSidebarThread(threadId, apply);
  const payloadPatch = mutations.applyThreadDataPatch(get(), threadId, apply);
  if (Object.keys(payloadPatch).length > 0) set(payloadPatch as any);

  if (!found) {
    scheduleProjectRefresh(get, data.projectId || undefined);
  }
}
