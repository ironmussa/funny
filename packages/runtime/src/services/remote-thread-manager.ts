/**
 * @domain subdomain: Team Collaboration
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Thread manager — delegates persistence to the central server
 * via WebSocket tunnel.
 *
 * Implements IThreadManager so it can be passed to AgentMessageHandler
 * without any changes to the handler logic.
 */

import type { IThreadManager } from './server-interfaces.js';

/**
 * Creates a thread manager that delegates to the server via WebSocket.
 */
export function createRemoteThreadManager(): IThreadManager {
  return {
    async getThread(id: string) {
      const { remoteGetThread } = await import('./remote-thread-data-client.js');
      return remoteGetThread(id);
    },

    async updateThread(id: string, updates: Record<string, any>) {
      const { remoteUpdateThread } = await import('./remote-thread-data-client.js');
      return remoteUpdateThread(id, updates);
    },

    async createPendingPermissionRequest(request) {
      const { remoteCreatePendingPermissionRequest } =
        await import('./remote-automation-policy-client.js');
      return remoteCreatePendingPermissionRequest(request);
    },

    async resolvePendingPermissionRequest(requestId, decision) {
      const { remoteResolvePendingPermissionRequest } =
        await import('./remote-automation-policy-client.js');
      return remoteResolvePendingPermissionRequest(requestId, decision);
    },

    async expirePendingPermissionRequest(requestId) {
      const { remoteExpirePendingPermissionRequest } =
        await import('./remote-automation-policy-client.js');
      return remoteExpirePendingPermissionRequest(requestId);
    },

    async getThreadWithMessages(
      id: string,
      messageLimit?: number,
      opts?: { messageProgress?: number },
    ) {
      const { remoteGetThreadWithMessages } = await import('./remote-thread-data-client.js');
      return remoteGetThreadWithMessages(id, messageLimit, opts);
    },

    async insertMessage(data) {
      const { remoteInsertMessage } = await import('./remote-thread-data-client.js');
      return remoteInsertMessage(data);
    },

    async updateMessage(id: string, content: string | { content: string; images?: string | null }) {
      const { remoteUpdateMessage } = await import('./remote-thread-data-client.js');
      return remoteUpdateMessage(id, content);
    },

    async deleteMessagesAfter(threadId: string, anchorMessageId: string) {
      const { remoteDeleteMessagesAfter } = await import('./remote-thread-data-client.js');
      return remoteDeleteMessagesAfter(threadId, anchorMessageId);
    },

    async insertToolCall(data) {
      const { remoteInsertToolCall } = await import('./remote-thread-data-client.js');
      return remoteInsertToolCall(data);
    },

    async updateToolCallOutput(id: string, output: string) {
      const { remoteUpdateToolCallOutput } = await import('./remote-thread-data-client.js');
      return remoteUpdateToolCallOutput(id, output);
    },

    async findToolCall(messageId: string, name: string, input: string) {
      const { remoteFindToolCall } = await import('./remote-thread-data-client.js');
      return remoteFindToolCall(messageId, name, input);
    },

    async getToolCall(id: string) {
      const { remoteGetToolCall } = await import('./remote-thread-data-client.js');
      return remoteGetToolCall(id);
    },
  };
}
