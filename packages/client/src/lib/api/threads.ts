import type {
  ImageAttachment,
  PaginatedMessages,
  PaginatedThreadsResponse,
  QueuedMessage,
  Thread,
  ThreadWithMessages,
} from '@funny/shared';

import { request } from './_core';

/** A per-thread share grant with the invited user's display fields. */
/**
 * Thread share level (unified-rbac-grants). Three explicit levels:
 *   `view`    — read only
 *   `comment` — read + post comments
 *   `steer`   — read + comment + read-only git + send follow-ups (edit)
 */
export type ShareLevel = 'view' | 'comment' | 'steer';

export interface ThreadShareGrant {
  threadId: string;
  sharedWithUserId: string;
  sharedByUserId: string;
  /** Defaults to `view` for grants created before the steer feature. */
  level: ShareLevel;
  createdAt: string;
  user: { id: string; name: string; image: string | null; username: string | null } | null;
}

export const threadsApi = {
  listThreads: (projectId?: string, includeArchived?: boolean, limit?: number, offset?: number) => {
    const params = new URLSearchParams();
    if (projectId) params.set('projectId', projectId);
    if (includeArchived) params.set('includeArchived', 'true');
    if (limit != null) params.set('limit', String(limit));
    if (offset != null) params.set('offset', String(offset));
    const qs = params.toString();
    return request<PaginatedThreadsResponse>(`/threads${qs ? `?${qs}` : ''}`);
  },
  listThreadsByDesign: (designId: string, limit = 100) => {
    const params = new URLSearchParams({ designId, limit: String(limit) });
    return request<PaginatedThreadsResponse>(`/threads?${params.toString()}`);
  },
  searchThreadContent: (query: string, projectId?: string, caseSensitive = false) => {
    const params = new URLSearchParams({ q: query });
    if (projectId) params.set('projectId', projectId);
    if (caseSensitive) params.set('caseSensitive', 'true');
    return request<{ threadIds: string[]; snippets: Record<string, string> }>(
      `/threads/search/content?${params.toString()}`,
    );
  },
  getThread: (
    id: string,
    messageLimit?: number,
    signal?: AbortSignal,
    opts: { messageProgress?: number; messageAnchorId?: string } = {},
  ) => {
    const params = new URLSearchParams();
    if (messageLimit) params.set('messageLimit', String(messageLimit));
    if (opts.messageProgress !== undefined) {
      params.set('messageProgress', String(opts.messageProgress));
    }
    if (opts.messageAnchorId) {
      params.set('messageAnchorId', opts.messageAnchorId);
    }
    const qs = params.toString();
    return request<ThreadWithMessages>(`/threads/${id}${qs ? `?${qs}` : ''}`, { signal });
  },
  getThreadMessages: (
    threadId: string,
    cursor: string,
    limit = 50,
    direction: 'before' | 'after' = 'before',
  ) => {
    const params = new URLSearchParams({ cursor, limit: String(limit), direction });
    return request<PaginatedMessages>(`/threads/${threadId}/messages?${params.toString()}`);
  },
  searchThreadMessages: (threadId: string, query: string, limit = 100, caseSensitive = false) => {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (caseSensitive) params.set('caseSensitive', 'true');
    return request<{
      results: Array<{
        messageId: string;
        role: string;
        content: string;
        timestamp: string;
        snippet: string;
      }>;
    }>(`/threads/${threadId}/messages/search?${params.toString()}`);
  },
  getThreadEvents: (threadId: string, signal?: AbortSignal) => {
    return request<{ events: Array<import('@funny/shared').ThreadEvent> }>(
      `/threads/${threadId}/events`,
      { signal },
    );
  },
  getTouchedFiles: (threadId: string, signal?: AbortSignal) => {
    return request<{ files: string[] }>(`/threads/${threadId}/touched-files`, { signal });
  },
  createThread: (data: {
    projectId: string;
    title: string;
    mode: string;
    runtime?: string;
    provider?: string;
    model?: string;
    permissionMode?: string;
    effort?: string;
    baseBranch?: string;
    prompt: string;
    images?: ImageAttachment[];
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
    worktreePath?: string;
    parentThreadId?: string;
    designId?: string;
    agentTemplateId?: string;
    templateVariables?: Record<string, string>;
  }) => request<Thread>('/threads', { method: 'POST', body: JSON.stringify(data) }),
  createIdleThread: (data: {
    projectId: string;
    title: string;
    mode: string;
    baseBranch?: string;
    prompt?: string;
    stage?: string;
    images?: ImageAttachment[];
    designId?: string;
  }) => request<Thread>('/threads/idle', { method: 'POST', body: JSON.stringify(data) }),
  /**
   * Create a scratch thread — projectless, no git, no worktree.
   * The server enforces projectId=null, mode='local', isScratch=true.
   */
  createScratchThread: (data: {
    prompt: string;
    model?: string;
    provider?: string;
    permissionMode?: string;
    title?: string;
    images?: ImageAttachment[];
  }) =>
    request<Thread>('/threads', {
      method: 'POST',
      body: JSON.stringify({
        isScratch: true,
        projectId: null,
        mode: 'local',
        prompt: data.prompt,
        title: data.title,
        model: data.model,
        provider: data.provider,
        permissionMode: data.permissionMode,
        images: data.images,
      }),
    }),
  /** List the current user's scratch threads. */
  listScratchThreads: (limit?: number, offset?: number) => {
    const params = new URLSearchParams();
    if (limit != null) params.set('limit', String(limit));
    if (offset != null) params.set('offset', String(offset));
    const qs = params.toString();
    return request<PaginatedThreadsResponse>(`/threads/scratch${qs ? `?${qs}` : ''}`);
  },
  sendMessage: (
    threadId: string,
    content: string,
    opts?: {
      provider?: string;
      model?: string;
      permissionMode?: string;
      effort?: string;
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
      forceQueue?: boolean;
    },
    images?: ImageAttachment[],
  ) =>
    request<{ ok: boolean; handledLocally?: 'shell_escape' }>(`/threads/${threadId}/message`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        provider: opts?.provider,
        model: opts?.model,
        permissionMode: opts?.permissionMode,
        effort: opts?.effort,
        images,
        allowedTools: opts?.allowedTools,
        disallowedTools: opts?.disallowedTools,
        fileReferences: opts?.fileReferences,
        symbolReferences: opts?.symbolReferences,
        baseBranch: opts?.baseBranch,
        forceQueue: opts?.forceQueue,
      }),
    }),
  stopThread: (threadId: string) =>
    request<{ ok: boolean }>(`/threads/${threadId}/stop`, { method: 'POST' }),
  updateThreadPermissionMode: (threadId: string, permissionMode: string) =>
    request<Thread>(`/threads/${threadId}/permission-mode`, {
      method: 'PATCH',
      body: JSON.stringify({ permissionMode }),
    }),
  convertToWorktree: (threadId: string, baseBranch?: string) =>
    request<{ ok: boolean }>(`/threads/${threadId}/convert-to-worktree`, {
      method: 'POST',
      body: JSON.stringify({ baseBranch }),
    }),
  forkThread: (threadId: string, messageId: string, title?: string) =>
    request<Thread>(`/threads/${threadId}/fork`, {
      method: 'POST',
      body: JSON.stringify({ messageId, title }),
    }),
  rewindCode: (threadId: string, messageId: string) =>
    request<{
      threadId: string;
      newSessionId: string;
      rewind: {
        canRewind: boolean;
        error?: string;
        filesChanged?: string[];
        insertions?: number;
        deletions?: number;
      };
      deletedMessageCount: number;
    }>(`/threads/${threadId}/rewind`, {
      method: 'POST',
      body: JSON.stringify({ messageId }),
    }),
  forkAndRewind: (threadId: string, messageId: string, title?: string) =>
    request<{
      thread: Thread;
      rewind: {
        canRewind: boolean;
        error?: string;
        filesChanged?: string[];
        insertions?: number;
        deletions?: number;
      };
    }>(`/threads/${threadId}/fork-and-rewind`, {
      method: 'POST',
      body: JSON.stringify({ messageId, title }),
    }),
  approveTool: (
    threadId: string,
    toolName: string,
    approved: boolean,
    allowedTools?: string[],
    disallowedTools?: string[],
    options?: { scope?: 'once' | 'always'; pattern?: string; toolInput?: string },
  ) =>
    request<{ ok: boolean }>(`/threads/${threadId}/approve-tool`, {
      method: 'POST',
      body: JSON.stringify({
        toolName,
        approved,
        allowedTools,
        disallowedTools,
        scope: options?.scope,
        pattern: options?.pattern,
        toolInput: options?.toolInput,
      }),
    }),
  respondPermissionRequest: (
    threadId: string,
    requestId: string,
    decision: import('@funny/shared').PermissionDecision,
  ) =>
    request<{ ok: boolean }>(`/threads/${threadId}/permission-requests/${requestId}/respond`, {
      method: 'POST',
      body: JSON.stringify({ decision }),
    }),
  deleteThread: (threadId: string) =>
    request<{ ok: boolean }>(`/threads/${threadId}`, { method: 'DELETE' }),
  updateToolCallOutput: (threadId: string, toolCallId: string, output: string) =>
    request<{ ok: boolean }>(`/threads/${threadId}/tool-calls/${toolCallId}`, {
      method: 'PATCH',
      body: JSON.stringify({ output }),
    }),

  // Queue management
  listQueue: (threadId: string) => request<QueuedMessage[]>(`/threads/${threadId}/queue`),
  updateQueuedMessage: (threadId: string, messageId: string, content: string) =>
    request<{ ok: boolean; queuedCount: number; message: QueuedMessage }>(
      `/threads/${threadId}/queue/${messageId}`,
      {
        method: 'PATCH',
        body: JSON.stringify({ content }),
      },
    ),
  cancelQueuedMessage: (threadId: string, messageId: string) =>
    request<{ ok: boolean; queuedCount: number }>(`/threads/${threadId}/queue/${messageId}`, {
      method: 'DELETE',
    }),
  archiveThread: (threadId: string, archived: boolean) =>
    request<Thread>(`/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ archived }),
    }),
  pinThread: (threadId: string, pinned: boolean) =>
    request<Thread>(`/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ pinned }),
    }),
  setSchedulerManaged: (threadId: string, schedulerManaged: boolean) =>
    request<Thread>(`/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ schedulerManaged }),
    }),
  renameThread: (threadId: string, title: string) =>
    request<Thread>(`/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ title }),
    }),
  updateThreadStage: (threadId: string, stage: string) =>
    request<Thread>(`/threads/${threadId}`, {
      method: 'PATCH',
      body: JSON.stringify({ stage }),
    }),

  // Thread comments
  getThreadComments: (threadId: string) =>
    request<import('@funny/shared').ThreadComment[]>(`/threads/${threadId}/comments`),
  createThreadComment: (threadId: string, content: string) =>
    request<import('@funny/shared').ThreadComment>(`/threads/${threadId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ content }),
    }),
  deleteThreadComment: (threadId: string, commentId: string) =>
    request(`/threads/${threadId}/comments/${commentId}`, { method: 'DELETE' }),

  // Thread sharing
  listThreadShares: (threadId: string) =>
    request<ThreadShareGrant[]>(`/threads/${threadId}/shares`),
  shareThread: (threadId: string, userId: string, level: ShareLevel = 'view') =>
    request<{
      threadId: string;
      sharedWithUserId: string;
      sharedByUserId: string;
      level: ShareLevel;
    }>(`/threads/${threadId}/shares`, { method: 'POST', body: JSON.stringify({ userId, level }) }),
  unshareThread: (threadId: string, userId: string) =>
    request<{ ok: boolean }>(`/threads/${threadId}/shares/${userId}`, { method: 'DELETE' }),
  listSharedWithMe: () => request<{ threads: Thread[] }>('/threads/shared-with-me'),
  uploadFile: (
    threadId: string,
    body: { provider: string; filename: string; contentBase64: string },
  ) =>
    request<{ path: string; size: number }>(`/threads/${threadId}/upload`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  listArchivedThreads: (params?: {
    page?: number;
    limit?: number;
    search?: string;
    projectId?: string;
  }) => {
    const p = new URLSearchParams();
    if (params?.page) p.set('page', String(params.page));
    if (params?.limit) p.set('limit', String(params.limit));
    if (params?.search) p.set('search', params.search);
    if (params?.projectId) p.set('projectId', params.projectId);
    const qs = p.toString();
    return request<{ threads: Thread[]; total: number; page: number; limit: number }>(
      `/threads/archived${qs ? `?${qs}` : ''}`,
    );
  },
};
