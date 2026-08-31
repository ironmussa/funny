import type { Message, PermissionDecision } from '@funny/shared';

import type { PortableMessage, ThreadWorkspaceState } from './thread-workspace';
import type { StoreApi } from './vanilla-store';

export interface PromptSubmission {
  threadId: string;
  content: string;
  optimisticMessage: PortableMessage;
}

export interface ResumeSubmission {
  threadId: string;
  runId: string;
  content: string;
}

export interface PermissionResponse {
  threadId: string;
  runId: string;
  requestId: string;
  decision: PermissionDecision;
}

export interface ThreadCommandPorts {
  submitPrompt(input: PromptSubmission): Promise<Message | void>;
  stopRun(threadId: string, runId: string | null): Promise<void>;
  resumeRun(input: ResumeSubmission): Promise<Message | void>;
  respondPermission(input: PermissionResponse): Promise<void>;
}

export interface ThreadCommandController {
  submitPrompt(input: PromptSubmission): Promise<boolean>;
  stopRun(threadId: string): Promise<boolean>;
  resumeRun(input: ResumeSubmission): Promise<boolean>;
  respondPermission(input: PermissionResponse): Promise<boolean>;
  isPromptPending(threadId: string): boolean;
  isStopPending(threadId: string): boolean;
  isResumePending(threadId: string): boolean;
  isPermissionPending(requestId: string): boolean;
}

function markMessageFailed(store: StoreApi<ThreadWorkspaceState>, input: PromptSubmission): void {
  const current =
    store.getState().byThreadId[input.threadId]?.messagesById[input.optimisticMessage.id];
  if (!current) return;
  store.getState().upsertDurableMessage(input.threadId, { ...current, delivery: 'failed' });
}

export function createThreadCommandController(options: {
  store: StoreApi<ThreadWorkspaceState>;
  ports: ThreadCommandPorts;
}): ThreadCommandController {
  const prompts = new Set<string>();
  const stops = new Set<string>();
  const resumes = new Set<string>();
  const permissions = new Set<string>();

  return {
    async submitPrompt(input) {
      if (prompts.has(input.threadId)) return false;
      prompts.add(input.threadId);
      options.store.getState().upsertDurableMessage(input.threadId, {
        ...input.optimisticMessage,
        delivery: 'optimistic',
      });
      try {
        const durable = await options.ports.submitPrompt(input);
        if (durable && durable.id !== input.optimisticMessage.id) {
          const data = options.store.getState().byThreadId[input.threadId];
          if (data) {
            const messageIds = data.messageIds.filter((id) => id !== input.optimisticMessage.id);
            const { [input.optimisticMessage.id]: _, ...messagesById } = data.messagesById;
            options.store.setState({
              byThreadId: {
                ...options.store.getState().byThreadId,
                [input.threadId]: { ...data, messageIds, messagesById },
              },
            });
          }
        }
        if (durable) options.store.getState().upsertDurableMessage(input.threadId, durable);
        return true;
      } catch {
        markMessageFailed(options.store, input);
        return false;
      } finally {
        prompts.delete(input.threadId);
      }
    },
    async stopRun(threadId) {
      if (stops.has(threadId)) return false;
      stops.add(threadId);
      try {
        const runId = options.store.getState().byThreadId[threadId]?.run.runId ?? null;
        await options.ports.stopRun(threadId, runId);
        return true;
      } catch {
        return false;
      } finally {
        stops.delete(threadId);
      }
    },
    async resumeRun(input) {
      if (resumes.has(input.threadId)) return false;
      resumes.add(input.threadId);
      try {
        const message = await options.ports.resumeRun(input);
        if (message) options.store.getState().upsertDurableMessage(input.threadId, message);
        return true;
      } catch {
        return false;
      } finally {
        resumes.delete(input.threadId);
      }
    },
    async respondPermission(input) {
      if (permissions.has(input.requestId)) return false;
      const permission = options.store.getState().byThreadId[input.threadId]?.permission;
      if (
        !permission ||
        permission.status !== 'active' ||
        permission.requestId !== input.requestId ||
        permission.runId !== input.runId
      )
        return false;
      permissions.add(input.requestId);
      try {
        await options.ports.respondPermission(input);
        return options.store
          .getState()
          .resolvePermission(input.threadId, input.requestId, input.decision);
      } catch {
        return false;
      } finally {
        permissions.delete(input.requestId);
      }
    },
    isPromptPending: (threadId) => prompts.has(threadId),
    isStopPending: (threadId) => stops.has(threadId),
    isResumePending: (threadId) => resumes.has(threadId),
    isPermissionPending: (requestId) => permissions.has(requestId),
  };
}
