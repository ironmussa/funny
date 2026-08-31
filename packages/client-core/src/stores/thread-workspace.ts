import type {
  Message,
  PendingPermissionRequest,
  PermissionDecision,
  ThreadStatus,
  ToolCall,
} from '@funny/shared';

import { createStore, type StoreApi } from './vanilla-store';

export type MessageDelivery = 'optimistic' | 'streaming' | 'confirmed' | 'failed';
export interface PortableMessage extends Message {
  delivery?: MessageDelivery;
}
export type PortableMessageInput = PortableMessage & { toolCalls?: ToolCall[] };

export interface PortableRunState {
  runId: string | null;
  status: ThreadStatus;
  error: string | null;
}

export interface PortablePermissionState extends PendingPermissionRequest {
  status: 'active' | 'resolved' | 'expired';
  decision?: PermissionDecision;
}

export interface ThreadWorkspaceData {
  messageIds: string[];
  messagesById: Record<string, PortableMessage>;
  toolCallIdsByMessage: Record<string, string[]>;
  toolCallsById: Record<string, ToolCall>;
  hasMore: boolean;
  hasMoreAfter: boolean;
  total: number | null;
  windowStart: number | null;
  run: PortableRunState;
  permission: PortablePermissionState | null;
  loading: boolean;
  error: string | null;
  eventRevisionByKey: Record<string, number>;
}

export interface StreamingDelta {
  eventId: string;
  messageId: string;
  threadId: string;
  revision: number;
  content: string;
  mode?: 'append' | 'replace';
  timestamp?: string;
}

export interface MessagePage {
  messages: readonly PortableMessageInput[];
  hasMore: boolean;
  hasMoreAfter?: boolean;
  total?: number;
  windowStart?: number;
}

export interface ThreadWorkspaceState {
  selectedThreadId: string | null;
  byThreadId: Record<string, ThreadWorkspaceData>;
  selectThread(threadId: string | null): void;
  replaceInitialPage(threadId: string, page: MessagePage): void;
  prependOlderPage(threadId: string, page: MessagePage): void;
  upsertDurableMessage(threadId: string, message: PortableMessageInput): void;
  applyStreamingDelta(delta: StreamingDelta): boolean;
  upsertToolCall(threadId: string, toolCall: ToolCall): void;
  updateToolOutput(threadId: string, toolCallId: string, output: string): void;
  setRun(threadId: string, run: Partial<PortableRunState>): void;
  setPermission(threadId: string, permission: PortablePermissionState | null): void;
  resolvePermission(threadId: string, requestId: string, decision: PermissionDecision): boolean;
  setLoading(threadId: string, loading: boolean): void;
  setError(threadId: string, error: string | null): void;
  removeThread(threadId: string): void;
  clearProtectedResources(): void;
}

export const MAX_RETAINED_THREAD_MESSAGES = 1_000;

const emptyRun = (): PortableRunState => ({ runId: null, status: 'idle', error: null });
const ACTIVE_RUN_STATUSES = new Set<ThreadStatus>(['setting_up', 'pending', 'running', 'waiting']);
const TERMINAL_RUN_STATUSES = new Set<ThreadStatus>([
  'completed',
  'failed',
  'stopped',
  'interrupted',
]);
export const createEmptyThreadWorkspace = (): ThreadWorkspaceData => ({
  messageIds: [],
  messagesById: {},
  toolCallIdsByMessage: {},
  toolCallsById: {},
  hasMore: false,
  hasMoreAfter: false,
  total: null,
  windowStart: null,
  run: emptyRun(),
  permission: null,
  loading: false,
  error: null,
  eventRevisionByKey: {},
});

function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function retainMessageWindow(
  data: ThreadWorkspaceData,
  edge: 'start' | 'end',
): ThreadWorkspaceData {
  if (data.messageIds.length <= MAX_RETAINED_THREAD_MESSAGES) return data;
  const messageIds =
    edge === 'start'
      ? data.messageIds.slice(0, MAX_RETAINED_THREAD_MESSAGES)
      : data.messageIds.slice(-MAX_RETAINED_THREAD_MESSAGES);
  const retained = new Set(messageIds);
  const messagesById = Object.fromEntries(
    Object.entries(data.messagesById).filter(([id]) => retained.has(id)),
  );
  const toolCallIdsByMessage = Object.fromEntries(
    Object.entries(data.toolCallIdsByMessage).filter(([messageId]) => retained.has(messageId)),
  );
  const retainedToolCalls = new Set(Object.values(toolCallIdsByMessage).flat());
  const toolCallsById = Object.fromEntries(
    Object.entries(data.toolCallsById).filter(([id]) => retainedToolCalls.has(id)),
  );
  return { ...data, messageIds, messagesById, toolCallIdsByMessage, toolCallsById };
}

function mergeMessage(
  data: ThreadWorkspaceData,
  input: PortableMessageInput,
  existingWins: boolean,
): ThreadWorkspaceData {
  const { toolCalls = [], ...message } = input;
  const existing = data.messagesById[message.id];
  const merged =
    existingWins && existing ? { ...message, ...existing } : { ...existing, ...message };
  let next = {
    ...data,
    messagesById: { ...data.messagesById, [message.id]: merged },
    messageIds: data.messageIds.includes(message.id)
      ? data.messageIds
      : [...data.messageIds, message.id],
  };
  for (const toolCall of toolCalls) next = mergeToolCall(next, toolCall);
  return next;
}

function mergeToolCall(data: ThreadWorkspaceData, toolCall: ToolCall): ThreadWorkspaceData {
  const ids = data.toolCallIdsByMessage[toolCall.messageId] ?? [];
  return {
    ...data,
    toolCallsById: {
      ...data.toolCallsById,
      [toolCall.id]: { ...data.toolCallsById[toolCall.id], ...toolCall },
    },
    toolCallIdsByMessage: ids.includes(toolCall.id)
      ? data.toolCallIdsByMessage
      : { ...data.toolCallIdsByMessage, [toolCall.messageId]: [...ids, toolCall.id] },
  };
}

function withThread(
  state: ThreadWorkspaceState,
  threadId: string,
  update: (data: ThreadWorkspaceData) => ThreadWorkspaceData,
): Partial<ThreadWorkspaceState> {
  const current = state.byThreadId[threadId] ?? createEmptyThreadWorkspace();
  const next = update(current);
  if (next === current) return {};
  return { byThreadId: { ...state.byThreadId, [threadId]: next } };
}

function pageData(current: ThreadWorkspaceData, page: MessagePage, prepend: boolean) {
  let next = current;
  for (const message of page.messages) next = mergeMessage(next, message, true);
  const incomingIds = uniqueIds(page.messages.map((message) => message.id));
  const messageIds = prepend
    ? uniqueIds([...incomingIds, ...current.messageIds])
    : uniqueIds([...incomingIds, ...current.messageIds.filter((id) => !incomingIds.includes(id))]);
  return retainMessageWindow(
    {
      ...next,
      messageIds,
      hasMore: page.hasMore,
      hasMoreAfter: page.hasMoreAfter ?? current.hasMoreAfter,
      total: page.total ?? current.total,
      windowStart: page.windowStart ?? current.windowStart,
      loading: false,
      error: null,
    },
    prepend ? 'start' : 'end',
  );
}

export function createThreadWorkspaceStore(): StoreApi<ThreadWorkspaceState> {
  const seenEventIds = new Set<string>();
  const seenEventQueue: string[] = [];
  return createStore<ThreadWorkspaceState>((set, get) => ({
    selectedThreadId: null,
    byThreadId: {},
    selectThread(selectedThreadId) {
      set({ selectedThreadId });
    },
    replaceInitialPage(threadId, page) {
      set((state) => withThread(state, threadId, (current) => pageData(current, page, false)));
    },
    prependOlderPage(threadId, page) {
      set((state) => withThread(state, threadId, (current) => pageData(current, page, true)));
    },
    upsertDurableMessage(threadId, message) {
      set((state) =>
        withThread(state, threadId, (current) => {
          const optimisticId = [...current.messageIds].reverse().find((id) => {
            const candidate = current.messagesById[id];
            return (
              candidate?.delivery === 'optimistic' &&
              candidate.role === message.role &&
              candidate.content === message.content &&
              id !== message.id
            );
          });
          let reconciled = current;
          if (optimisticId) {
            const { [optimisticId]: _, ...messagesById } = current.messagesById;
            reconciled = {
              ...current,
              messageIds: current.messageIds.filter((id) => id !== optimisticId),
              messagesById,
            };
          }
          return retainMessageWindow(
            mergeMessage(
              reconciled,
              { ...message, delivery: message.delivery ?? 'confirmed' },
              false,
            ),
            'end',
          );
        }),
      );
    },
    applyStreamingDelta(delta) {
      const eventKey = `${delta.threadId}:${delta.eventId}`;
      const revisionKey = `message:${delta.messageId}`;
      const current = get().byThreadId[delta.threadId] ?? createEmptyThreadWorkspace();
      if (
        seenEventIds.has(eventKey) ||
        delta.revision <= (current.eventRevisionByKey[revisionKey] ?? -1)
      ) {
        return false;
      }
      seenEventIds.add(eventKey);
      seenEventQueue.push(eventKey);
      if (seenEventQueue.length > 2_048) {
        const expired = seenEventQueue.shift();
        if (expired) seenEventIds.delete(expired);
      }
      set((state) =>
        withThread(state, delta.threadId, (data) => {
          const existing = data.messagesById[delta.messageId];
          const content =
            delta.mode === 'replace' ? delta.content : `${existing?.content ?? ''}${delta.content}`;
          const message: PortableMessage = {
            id: delta.messageId,
            threadId: delta.threadId,
            role: 'assistant',
            content,
            timestamp: delta.timestamp ?? existing?.timestamp ?? new Date(0).toISOString(),
            delivery: 'streaming',
          };
          const next = mergeMessage(data, message, false);
          return retainMessageWindow(
            {
              ...next,
              eventRevisionByKey: { ...data.eventRevisionByKey, [revisionKey]: delta.revision },
            },
            'end',
          );
        }),
      );
      return true;
    },
    upsertToolCall(threadId, toolCall) {
      set((state) => withThread(state, threadId, (data) => mergeToolCall(data, toolCall)));
    },
    updateToolOutput(threadId, toolCallId, output) {
      set((state) =>
        withThread(state, threadId, (data) => {
          const current = data.toolCallsById[toolCallId];
          if (!current) return data;
          return {
            ...data,
            toolCallsById: { ...data.toolCallsById, [toolCallId]: { ...current, output } },
          };
        }),
      );
    },
    setRun(threadId, run) {
      set((state) =>
        withThread(state, threadId, (data) => {
          const next = { ...data.run, ...run };
          const sameRun = !next.runId || !data.run.runId || next.runId === data.run.runId;
          if (
            sameRun &&
            TERMINAL_RUN_STATUSES.has(data.run.status) &&
            ACTIVE_RUN_STATUSES.has(next.status)
          )
            return data;
          if (
            next.runId === data.run.runId &&
            next.status === data.run.status &&
            next.error === data.run.error
          )
            return data;
          return { ...data, run: next };
        }),
      );
    },
    setPermission(threadId, permission) {
      set((state) =>
        withThread(state, threadId, (data) => {
          const current = data.permission;
          if (current && permission) {
            if (current.requestId === permission.requestId && current.status !== 'active')
              return data;
            if (current.requestedAt > permission.requestedAt) return data;
          }
          return { ...data, permission };
        }),
      );
    },
    resolvePermission(threadId, requestId, decision) {
      const current = get().byThreadId[threadId]?.permission;
      if (!current || current.requestId !== requestId || current.status !== 'active') return false;
      set((state) =>
        withThread(state, threadId, (data) => ({
          ...data,
          permission: data.permission ? { ...data.permission, status: 'resolved', decision } : null,
        })),
      );
      return true;
    },
    setLoading(threadId, loading) {
      set((state) => withThread(state, threadId, (data) => ({ ...data, loading })));
    },
    setError(threadId, error) {
      set((state) => withThread(state, threadId, (data) => ({ ...data, error, loading: false })));
    },
    removeThread(threadId) {
      set((state) => {
        if (!state.byThreadId[threadId]) return {};
        const { [threadId]: _, ...byThreadId } = state.byThreadId;
        return {
          byThreadId,
          selectedThreadId: state.selectedThreadId === threadId ? null : state.selectedThreadId,
        };
      });
    },
    clearProtectedResources() {
      seenEventIds.clear();
      seenEventQueue.length = 0;
      set({ selectedThreadId: null, byThreadId: {} });
    },
  }));
}
