import type { DataInsertMessage, DataInsertToolCall } from '@funny/shared/runner-protocol';

import { log } from '../lib/logger.js';
import { sendRemoteData } from './remote-data-channel.js';

export type RemoteDataRequest = (eventType: string, payload: Record<string, any>) => Promise<any>;

export interface RemoteThreadMessageMatch {
  threadId: string;
  threadTitle: string;
  messageId: string;
  role: string;
  author: string | null;
  timestamp: string;
  snippet: string;
}

/** Cohesive remote client for threads, messages, tool calls, and message queues. */
export class RemoteThreadDataClient {
  private readonly threadCache = new Map<string, { value: any; expiry: number }>();
  private readonly threadInflight = new Map<string, Promise<any>>();
  private readonly pendingMessageUpdates = new Map<
    string,
    { content: string; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly request: RemoteDataRequest,
    private readonly now: () => number = Date.now,
  ) {}

  async insertMessage(data: DataInsertMessage['payload']): Promise<string> {
    return (await this.request('data:insert_message', { payload: data })).messageId;
  }

  async insertToolCall(data: DataInsertToolCall['payload']): Promise<string> {
    return (await this.request('data:insert_tool_call', { payload: data })).toolCallId;
  }

  async updateThread(threadId: string, updates: Record<string, any>): Promise<void> {
    this.invalidateThread(threadId);
    await this.request('data:update_thread', { payload: { threadId, updates } });
  }

  async updateMessage(
    messageId: string,
    data: string | { content: string; images?: string | null },
  ): Promise<void> {
    const content = typeof data === 'string' ? data : data.content;
    const existing = this.pendingMessageUpdates.get(messageId);
    if (existing) clearTimeout(existing.timer);
    const timer = setTimeout(() => {
      const pending = this.pendingMessageUpdates.get(messageId);
      if (!pending) return;
      this.pendingMessageUpdates.delete(messageId);
      this.emitMessageUpdate(messageId, pending.content);
    }, 100);
    this.pendingMessageUpdates.set(messageId, { content, timer });
  }

  flushMessageUpdates(): void {
    for (const [messageId, pending] of this.pendingMessageUpdates) {
      clearTimeout(pending.timer);
      this.emitMessageUpdate(messageId, pending.content);
    }
    this.pendingMessageUpdates.clear();
  }

  async deleteMessagesAfter(threadId: string, anchorMessageId: string): Promise<number> {
    const response = await this.request('data:delete_messages_after', {
      payload: { threadId, anchorMessageId },
    });
    return response.deletedCount ?? 0;
  }

  async saveThreadEvent(
    threadId: string,
    type: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    await this.request('data:save_thread_event', {
      payload: { threadId, eventType: type, data },
    });
  }

  async updateToolCallOutput(toolCallId: string, output: string): Promise<void> {
    await this.request('data:update_tool_call_output', { payload: { toolCallId, output } });
  }

  async getThread(threadId: string): Promise<any> {
    const cached = this.threadCache.get(threadId);
    if (cached && this.now() < cached.expiry) return cached.value;
    const inflight = this.threadInflight.get(threadId);
    if (inflight) return inflight;
    const promise = this.request('data:get_thread', { threadId })
      .then((response) => {
        const thread = response?.thread ?? null;
        this.threadCache.set(threadId, { value: thread, expiry: this.now() + 3_000 });
        return thread;
      })
      .finally(() => this.threadInflight.delete(threadId));
    this.threadInflight.set(threadId, promise);
    return promise;
  }

  async getThreadByExternalRequestId(externalRequestId: string): Promise<any | undefined> {
    return (
      (await this.request('data:get_thread_by_external_request_id', { externalRequestId }))
        ?.thread ?? undefined
    );
  }

  async getThreadBySessionId(sessionId: string): Promise<any | undefined> {
    return (
      (await this.request('data:get_thread_by_session_id', { sessionId }))?.thread ?? undefined
    );
  }

  invalidateThread(threadId: string): void {
    this.threadCache.delete(threadId);
  }

  async getThreadWithMessages(
    threadId: string,
    messageLimit?: number,
    opts: { messageProgress?: number } = {},
  ): Promise<any> {
    const response = await this.request('data:get_thread_with_messages', {
      threadId,
      ...(messageLimit !== undefined ? { messageLimit } : {}),
      ...(opts.messageProgress !== undefined ? { messageProgress: opts.messageProgress } : {}),
    });
    return response?.thread ?? null;
  }

  async getThreadMessages(opts: {
    threadId: string;
    cursor?: string;
    limit: number;
    direction?: 'before' | 'after';
  }) {
    const response = await this.request('data:get_thread_messages', {
      threadId: opts.threadId,
      limit: opts.limit,
      ...(opts.cursor !== undefined ? { cursor: opts.cursor } : {}),
      ...(opts.direction !== undefined ? { direction: opts.direction } : {}),
    });
    return {
      messages: Array.isArray(response?.messages) ? response.messages : [],
      hasMore: !!response?.hasMore,
      hasMoreAfter: !!response?.hasMoreAfter,
      total: typeof response?.total === 'number' ? response.total : undefined,
      windowStart: typeof response?.windowStart === 'number' ? response.windowStart : undefined,
      leadingUserMessage: response?.leadingUserMessage,
    };
  }

  async searchThreads(opts: Record<string, unknown>): Promise<RemoteThreadMessageMatch[]> {
    const response = await this.request('data:search_threads', { ...opts });
    return Array.isArray(response?.results) ? response.results : [];
  }

  async getAgentTemplate(templateId: string): Promise<any> {
    return (await this.request('data:get_agent_template', { templateId }))?.template ?? null;
  }
  async getToolCall(toolCallId: string): Promise<any> {
    return (await this.request('data:get_tool_call', { toolCallId }))?.toolCall ?? null;
  }
  async findToolCall(messageId: string, name: string, input: string): Promise<any> {
    return (
      (await this.request('data:find_tool_call', { payload: { messageId, name, input } }))
        ?.toolCall ?? null
    );
  }
  async findLastUnansweredInteractiveToolCall(threadId: string) {
    return (
      (await this.request('data:find_last_unanswered_interactive_tool_call', { threadId }))
        ?.toolCall ?? undefined
    );
  }
  async createThread(data: Record<string, any>): Promise<void> {
    await this.request('data:create_thread', { payload: data });
  }
  async deleteThread(threadId: string): Promise<void> {
    await this.request('data:delete_thread', { threadId });
  }
  enqueueMessage(threadId: string, data: Record<string, any>) {
    return this.request('data:enqueue_message', { threadId, payload: data });
  }
  async dequeueMessage(threadId: string) {
    return (await this.request('data:dequeue_message', { threadId }))?.dequeued ?? null;
  }
  async peekMessage(threadId: string) {
    return (await this.request('data:peek_message', { threadId }))?.peeked ?? null;
  }
  async queueCount(threadId: string): Promise<number> {
    return (await this.request('data:queue_count', { threadId }))?.count ?? 0;
  }
  async listQueue(threadId: string): Promise<any[]> {
    return (await this.request('data:list_queue', { threadId }))?.items ?? [];
  }
  async cancelQueuedMessage(messageId: string): Promise<boolean> {
    return (await this.request('data:cancel_queued_message', { messageId }))?.success ?? false;
  }
  async updateQueuedMessage(messageId: string, content: string) {
    return (
      (await this.request('data:update_queued_message', { messageId, content }))?.updated ?? null
    );
  }
  async markAndListStaleThreads(): Promise<any[]> {
    return (await this.request('data:mark_and_list_stale_threads', {}))?.threads ?? [];
  }

  private emitMessageUpdate(messageId: string, content: string): void {
    void this.request('data:update_message', { payload: { messageId, content } }).catch((error) => {
      log.warn('Failed to persist debounced message update over gRPC', {
        namespace: 'runner',
        messageId,
        error: (error as Error).message,
      });
    });
  }
}

export const remoteThreadDataClient = new RemoteThreadDataClient(sendRemoteData);

export const remoteInsertMessage =
  remoteThreadDataClient.insertMessage.bind(remoteThreadDataClient);
export const remoteInsertToolCall =
  remoteThreadDataClient.insertToolCall.bind(remoteThreadDataClient);
export const remoteUpdateThread = remoteThreadDataClient.updateThread.bind(remoteThreadDataClient);
export const remoteUpdateMessage =
  remoteThreadDataClient.updateMessage.bind(remoteThreadDataClient);
export const flushPendingMessageUpdates =
  remoteThreadDataClient.flushMessageUpdates.bind(remoteThreadDataClient);
export const remoteDeleteMessagesAfter =
  remoteThreadDataClient.deleteMessagesAfter.bind(remoteThreadDataClient);
export const remoteSaveThreadEvent =
  remoteThreadDataClient.saveThreadEvent.bind(remoteThreadDataClient);
export const remoteUpdateToolCallOutput =
  remoteThreadDataClient.updateToolCallOutput.bind(remoteThreadDataClient);
export const remoteGetThread = remoteThreadDataClient.getThread.bind(remoteThreadDataClient);
export const remoteGetThreadByExternalRequestId =
  remoteThreadDataClient.getThreadByExternalRequestId.bind(remoteThreadDataClient);
export const remoteGetThreadBySessionId =
  remoteThreadDataClient.getThreadBySessionId.bind(remoteThreadDataClient);
export const invalidateThreadCache =
  remoteThreadDataClient.invalidateThread.bind(remoteThreadDataClient);
export const remoteGetThreadWithMessages =
  remoteThreadDataClient.getThreadWithMessages.bind(remoteThreadDataClient);
export const remoteGetThreadMessages =
  remoteThreadDataClient.getThreadMessages.bind(remoteThreadDataClient);
export const remoteSearchThreads =
  remoteThreadDataClient.searchThreads.bind(remoteThreadDataClient);
export const remoteGetAgentTemplate =
  remoteThreadDataClient.getAgentTemplate.bind(remoteThreadDataClient);
export const remoteGetToolCall = remoteThreadDataClient.getToolCall.bind(remoteThreadDataClient);
export const remoteFindToolCall = remoteThreadDataClient.findToolCall.bind(remoteThreadDataClient);
export const remoteFindLastUnansweredInteractiveToolCall =
  remoteThreadDataClient.findLastUnansweredInteractiveToolCall.bind(remoteThreadDataClient);
export const remoteCreateThread = remoteThreadDataClient.createThread.bind(remoteThreadDataClient);
export const remoteDeleteThread = remoteThreadDataClient.deleteThread.bind(remoteThreadDataClient);
export const remoteEnqueueMessage =
  remoteThreadDataClient.enqueueMessage.bind(remoteThreadDataClient);
export const remoteDequeueMessage =
  remoteThreadDataClient.dequeueMessage.bind(remoteThreadDataClient);
export const remotePeekMessage = remoteThreadDataClient.peekMessage.bind(remoteThreadDataClient);
export const remoteQueueCount = remoteThreadDataClient.queueCount.bind(remoteThreadDataClient);
export const remoteListQueue = remoteThreadDataClient.listQueue.bind(remoteThreadDataClient);
export const remoteCancelQueuedMessage =
  remoteThreadDataClient.cancelQueuedMessage.bind(remoteThreadDataClient);
export const remoteUpdateQueuedMessage =
  remoteThreadDataClient.updateQueuedMessage.bind(remoteThreadDataClient);
export const remoteMarkAndListStaleThreads =
  remoteThreadDataClient.markAndListStaleThreads.bind(remoteThreadDataClient);
