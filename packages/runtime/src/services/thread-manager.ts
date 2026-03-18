/**
 * @domain subdomain: Thread Management
 * @domain subdomain-type: core
 * @domain type: module
 * @domain layer: domain
 *
 * Thread manager — convenience barrel that delegates to getServices().
 * Keeps the `import * as tm from './thread-manager.js'` pattern working
 * across the many consumers in routes and services.
 */

import { getServices } from './service-registry.js';

// ── Thread CRUD ─────────────────────────────────────────────
export const listThreads = (
  ...args: Parameters<ReturnType<typeof getServices>['threads']['listThreads']>
) => getServices().threads.listThreads(...args);
export const listArchivedThreads = (
  ...args: Parameters<ReturnType<typeof getServices>['threads']['listArchivedThreads']>
) => getServices().threads.listArchivedThreads(...args);
export const getThread = (id: string) => getServices().threads.getThread(id);
export const getThreadByExternalRequestId = (id: string) =>
  getServices().threads.getThreadByExternalRequestId(id);
export const createThread = (data: Record<string, any>) => getServices().threads.createThread(data);
export const updateThread = (id: string, updates: Record<string, any>) =>
  getServices().threads.updateThread(id, updates);
export const deleteThread = (id: string) => getServices().threads.deleteThread(id);
export const markStaleThreadsInterrupted = () =>
  getServices().threads.markStaleThreadsInterrupted();
export const markStaleExternalThreadsStopped = () =>
  getServices().threads.markStaleExternalThreadsStopped();

// ── Messages ────────────────────────────────────────────────
export const getThreadWithMessages = (id: string) =>
  getServices().threads.getThreadWithMessages(id);
export const getThreadMessages = (threadId: string) =>
  getServices().threads.getThreadMessages(threadId);
export const insertMessage = (data: {
  threadId: string;
  role: string;
  content: string;
  images?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  author?: string | null;
}) => getServices().threads.insertMessage(data);
export const updateMessage = (id: string, content: string) =>
  getServices().threads.updateMessage(id, content);

// ── Tool calls ──────────────────────────────────────────────
export const insertToolCall = (data: {
  messageId: string;
  name: string;
  input: string;
  author?: string | null;
  parentToolCallId?: string | null;
}) => getServices().threads.insertToolCall(data);
export const updateToolCallOutput = (id: string, output: string) =>
  getServices().threads.updateToolCallOutput(id, output);
export const findToolCall = (messageId: string, name: string, input: string) =>
  getServices().threads.findToolCall(messageId, name, input);
export const getToolCall = (id: string) => getServices().threads.getToolCall(id);
export const findLastUnansweredInteractiveToolCall = (threadId: string) =>
  getServices().threads.findLastUnansweredInteractiveToolCall(threadId);

// ── Comments ────────────────────────────────────────────────
export const listComments = (threadId: string) => getServices().threads.listComments(threadId);
export const insertComment = (data: {
  threadId: string;
  userId: string;
  content: string;
  toolCallId?: string | null;
}) => getServices().threads.insertComment(data);
export const deleteComment = (id: string) => getServices().threads.deleteComment(id);
export const getCommentCounts = (threadIds: string[]) =>
  getServices().threads.getCommentCounts(threadIds);

// ── Search ──────────────────────────────────────────────────
export const searchThreadIdsByContent = (opts: {
  query: string;
  projectId?: string;
  userId: string;
}) => getServices().threads.searchThreadIdsByContent(opts);
