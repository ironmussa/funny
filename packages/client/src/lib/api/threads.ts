import type {
  ImageAttachment,
  PermissionMode,
  QueuedMessage,
  Thread,
  ThreadStage,
} from '@funny/shared';

import { request } from './_core';
import { trpc, trpcCall } from './_trpc';

const procedures = trpc.threads;

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

/** Agent options a written message carries. */
interface MessageOptions {
  provider?: string;
  model?: string;
  permissionMode?: string;
  effort?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  fileReferences?: { path: string }[];
}

export const threadsApi = {
  listThreads: (projectId?: string, includeArchived?: boolean, limit?: number, offset?: number) =>
    trpcCall(() =>
      procedures.list.query({ projectId: projectId || undefined, includeArchived, limit, offset }),
    ),
  listThreadsByDesign: (designId: string, limit = 100) =>
    trpcCall(() => procedures.list.query({ designId, limit })),
  searchThreadContent: (query: string, projectId?: string, caseSensitive = false) =>
    trpcCall(() =>
      procedures.searchContent.query({
        q: query,
        projectId: projectId || undefined,
        caseSensitive: caseSensitive || undefined,
      }),
    ),
  getThread: (
    id: string,
    messageLimit?: number,
    signal?: AbortSignal,
    opts: { messageProgress?: number; messageAnchorId?: string } = {},
  ) =>
    trpcCall(() =>
      procedures.get.query(
        {
          id,
          messageLimit: messageLimit || undefined,
          messageProgress: opts.messageProgress,
          messageAnchorId: opts.messageAnchorId || undefined,
        },
        { signal },
      ),
    ),
  getThreadMessages: (
    threadId: string,
    cursor: string,
    limit = 50,
    direction: 'before' | 'after' = 'before',
  ) => trpcCall(() => procedures.messages.query({ id: threadId, cursor, limit, direction })),
  searchThreadMessages: (threadId: string, query: string, limit = 100, caseSensitive = false) =>
    trpcCall(() =>
      procedures.searchMessages.query({
        id: threadId,
        q: query,
        limit,
        caseSensitive: caseSensitive || undefined,
      }),
    ),
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
    /** Ids from `stageUpload`, adopted into the new thread. */
    stagedUploads?: string[];
    worktreePath?: string;
    parentThreadId?: string;
    designId?: string;
    agentTemplateId?: string;
    templateVariables?: Record<string, string>;
    /** With `runtime: 'sandbox'`: the provider connection to run the thread on. */
    /** Without a connection, the server uses the caller's project sandbox. */
    sandbox?: { connectionId?: string; sizeId?: string };
  }) => request<Thread>('/threads', { method: 'POST', body: JSON.stringify(data) }),
  createIdleThread: (data: {
    projectId: string;
    title: string;
    mode: string;
    baseBranch?: string;
    prompt?: string;
    stage?: string;
    images?: ImageAttachment[];
    /** Stored as path-only references, read when the thread starts. */
    fileReferences?: { path: string }[];
    stagedUploads?: string[];
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
    fileReferences?: { path: string }[];
    stagedUploads?: string[];
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
        fileReferences: data.fileReferences,
        stagedUploads: data.stagedUploads,
      }),
    }),
  /** List the current user's scratch threads. */
  listScratchThreads: (limit?: number, offset?: number) =>
    trpcCall(() => procedures.scratch.query({ limit, offset })),
  sendMessage: (
    threadId: string,
    content: string,
    opts?: MessageOptions & {
      symbolReferences?: {
        path: string;
        name: string;
        kind: string;
        line: number;
        endLine?: number;
      }[];
      /** Ids from `stageUpload` — set when the composer had no thread id. */
      stagedUploads?: string[];
      baseBranch?: string;
      forceQueue?: boolean;
    },
    images?: ImageAttachment[],
  ) =>
    request<{ ok: boolean; handledLocally?: 'shell_escape' }>(`/threads/${threadId}/message`, {
      method: 'POST',
      // Undefined options are dropped by JSON.stringify.
      body: JSON.stringify({ content, images, ...opts }),
    }),
  /**
   * A message written on a sandbox thread whose setup failed: the server
   * provisions a new sandbox and starts the agent with it (thread-sandboxes).
   */
  retrySandboxThread: (
    threadId: string,
    content: string,
    opts?: MessageOptions,
    images?: ImageAttachment[],
  ) =>
    request<Thread>(`/threads/${threadId}/sandbox-retry`, {
      method: 'POST',
      body: JSON.stringify({ content, images, ...opts }),
    }),
  stopThread: (threadId: string) =>
    request<{ ok: boolean }>(`/threads/${threadId}/stop`, { method: 'POST' }),
  updateThreadPermissionMode: (threadId: string, permissionMode: PermissionMode) =>
    trpcCall(() => procedures.setPermissionMode.mutate({ id: threadId, permissionMode })),
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
      /** Rewind no longer forks a provider session: the next turn rebuilds the history. */
      newSessionId: null;
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
    trpcCall(() => procedures.update.mutate({ id: threadId, data: { archived } })),
  pinThread: (threadId: string, pinned: boolean) =>
    trpcCall(() => procedures.update.mutate({ id: threadId, data: { pinned } })),
  setSchedulerManaged: (threadId: string, schedulerManaged: boolean) =>
    trpcCall(() => procedures.update.mutate({ id: threadId, data: { schedulerManaged } })),
  renameThread: (threadId: string, title: string) =>
    trpcCall(() => procedures.update.mutate({ id: threadId, data: { title } })),
  updateThreadStage: (threadId: string, stage: ThreadStage) =>
    trpcCall(() => procedures.update.mutate({ id: threadId, data: { stage } })),

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
  /**
   * Park an attachment for a thread that does not exist yet. `projectId`
   * routes it to the project's runner (omit for scratch threads); pass the
   * returned `stagedId` as `stagedUploads` when creating the thread.
   */
  stageUpload: (
    body: { provider: string; filename: string; contentBase64: string },
    projectId?: string,
  ) =>
    request<{ stagedId: string; name: string; size: number }>(
      `/uploads/staging${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  listArchivedThreads: (params?: {
    page?: number;
    limit?: number;
    search?: string;
    projectId?: string;
  }) =>
    trpcCall(() =>
      procedures.archived.query({
        page: params?.page || undefined,
        limit: params?.limit || undefined,
        search: params?.search || undefined,
        projectId: params?.projectId || undefined,
      }),
    ),
};
