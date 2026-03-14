/**
 * @domain subdomain: Team Collaboration
 * @domain subdomain-type: supporting
 * @domain type: adapter
 * @domain layer: infrastructure
 *
 * Remote thread manager — delegates persistence to the central server
 * via WebSocket when running in team mode, otherwise falls back to local DB.
 *
 * Implements IThreadManager so it can be passed to AgentMessageHandler
 * without any changes to the handler logic.
 */

import type { IThreadManager } from './server-interfaces.js';

/**
 * Creates a thread manager that delegates to the remote server in team mode,
 * or falls back to local DB operations.
 */
export function createRemoteThreadManager(): IThreadManager {
  return {
    async getThread(id: string) {
      const { isTeamModeActive } = await import('./team-client.js');
      if (isTeamModeActive()) {
        const { remoteGetThread } = await import('./team-client.js');
        return remoteGetThread(id);
      }
      const { getThread } = await import('./thread-repository.js');
      return getThread(id);
    },

    async updateThread(id: string, updates: Record<string, any>) {
      const { isTeamModeActive } = await import('./team-client.js');
      if (isTeamModeActive()) {
        const { remoteUpdateThread } = await import('./team-client.js');
        return remoteUpdateThread(id, updates);
      }
      const { updateThread } = await import('./thread-repository.js');
      return updateThread(id, updates);
    },

    async getThreadWithMessages(id: string) {
      // Read-heavy operation — works through local DB or HTTP tunnel in both modes
      const { getThreadWithMessages } = await import('./message-repository.js');
      return getThreadWithMessages(id);
    },

    async insertMessage(data) {
      const { isTeamModeActive } = await import('./team-client.js');
      if (isTeamModeActive()) {
        const { remoteInsertMessage } = await import('./team-client.js');
        return remoteInsertMessage(data);
      }
      const { insertMessage } = await import('./message-repository.js');
      return insertMessage(data);
    },

    async updateMessage(id: string, content: string) {
      const { isTeamModeActive } = await import('./team-client.js');
      if (isTeamModeActive()) {
        const { remoteUpdateMessage } = await import('./team-client.js');
        return remoteUpdateMessage(id, content);
      }
      const { updateMessage } = await import('./message-repository.js');
      return updateMessage(id, content);
    },

    async insertToolCall(data) {
      const { isTeamModeActive } = await import('./team-client.js');
      if (isTeamModeActive()) {
        const { remoteInsertToolCall } = await import('./team-client.js');
        return remoteInsertToolCall(data);
      }
      const { insertToolCall } = await import('./tool-call-repository.js');
      return insertToolCall(data);
    },

    async updateToolCallOutput(id: string, output: string) {
      const { isTeamModeActive } = await import('./team-client.js');
      if (isTeamModeActive()) {
        const { remoteUpdateToolCallOutput } = await import('./team-client.js');
        return remoteUpdateToolCallOutput(id, output);
      }
      const { updateToolCallOutput } = await import('./tool-call-repository.js');
      return updateToolCallOutput(id, output);
    },

    async findToolCall(messageId: string, name: string, input: string) {
      const { isTeamModeActive } = await import('./team-client.js');
      if (isTeamModeActive()) {
        const { remoteFindToolCall } = await import('./team-client.js');
        return remoteFindToolCall(messageId, name, input);
      }
      const { findToolCall } = await import('./tool-call-repository.js');
      return findToolCall(messageId, name, input);
    },

    async getToolCall(id: string) {
      const { isTeamModeActive } = await import('./team-client.js');
      if (isTeamModeActive()) {
        const { remoteGetToolCall } = await import('./team-client.js');
        return remoteGetToolCall(id);
      }
      const { getToolCall } = await import('./tool-call-repository.js');
      return getToolCall(id);
    },
  };
}
