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
export const getThread = (id: string) => getServices().threads.getThread(id);
export const getThreadByExternalRequestId = (id: string) =>
  getServices().threads.getThreadByExternalRequestId(id);
export const createThread = (data: Record<string, any>) => getServices().threads.createThread(data);
export const updateThread = (id: string, updates: Record<string, any>) =>
  getServices().threads.updateThread(id, updates);
export const resolvePendingPermissionRequest = (
  ...args: Parameters<
    NonNullable<ReturnType<typeof getServices>['threads']['resolvePendingPermissionRequest']>
  >
) => getServices().threads.resolvePendingPermissionRequest?.(...args);
export const deleteThread = (id: string) => getServices().threads.deleteThread(id);

// ── Messages ────────────────────────────────────────────────
export const getThreadWithMessages = (
  ...args: Parameters<ReturnType<typeof getServices>['threads']['getThreadWithMessages']>
) => getServices().threads.getThreadWithMessages(...args);
export const getThreadMessages = (opts: {
  threadId: string;
  cursor?: string;
  limit: number;
  direction?: 'before' | 'after';
}) => getServices().threads.getThreadMessages(opts);
export const insertMessage = (data: {
  threadId: string;
  role: string;
  content: string;
  images?: string | null;
  model?: string | null;
  permissionMode?: string | null;
  effort?: string | null;
  author?: string | null;
  timestamp?: string | null;
}) => getServices().threads.insertMessage(data);
export const updateMessage = (
  id: string,
  data: string | { content: string; images?: string | null },
) => getServices().threads.updateMessage(id, data);
export const deleteMessagesAfter = (threadId: string, anchorMessageId: string) =>
  getServices().threads.deleteMessagesAfter(threadId, anchorMessageId);

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
export const findLastUnansweredInteractiveToolCall = (threadId: string) =>
  getServices().threads.findLastUnansweredInteractiveToolCall(threadId);

// ── Comments ────────────────────────────────────────────────
export const insertComment = (data: {
  threadId: string;
  userId: string;
  content: string;
  toolCallId?: string | null;
}) => getServices().threads.insertComment(data);
export const deleteComment = (id: string) => getServices().threads.deleteComment(id);
