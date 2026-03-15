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
      const { remoteGetThread } = await import('./team-client.js');
      return remoteGetThread(id);
    },

    async updateThread(id: string, updates: Record<string, any>) {
      const { remoteUpdateThread } = await import('./team-client.js');
      return remoteUpdateThread(id, updates);
    },

    async getThreadWithMessages(id: string) {
      // Read-heavy — forwarded via HTTP tunnel
      const { getServices } = await import('./service-registry.js');
      return getServices().threads.getThreadWithMessages(id);
    },

    async insertMessage(data) {
      const { remoteInsertMessage } = await import('./team-client.js');
      return remoteInsertMessage(data);
    },

    async updateMessage(id: string, content: string) {
      const { remoteUpdateMessage } = await import('./team-client.js');
      return remoteUpdateMessage(id, content);
    },

    async insertToolCall(data) {
      const { remoteInsertToolCall } = await import('./team-client.js');
      return remoteInsertToolCall(data);
    },

    async updateToolCallOutput(id: string, output: string) {
      const { remoteUpdateToolCallOutput } = await import('./team-client.js');
      return remoteUpdateToolCallOutput(id, output);
    },

    async findToolCall(messageId: string, name: string, input: string) {
      const { remoteFindToolCall } = await import('./team-client.js');
      return remoteFindToolCall(messageId, name, input);
    },

    async getToolCall(id: string) {
      const { remoteGetToolCall } = await import('./team-client.js');
      return remoteGetToolCall(id);
    },
  };
}
