/**
 * Service provider for the runtime runner.
 *
 * The runtime is always a remote runner connected to the central server.
 * This is the ONLY service provider — there is no in-process alternative.
 *
 * This provider:
 *  - Proxies thread/message/toolcall/project/profile ops via the WebSocket
 *    data channel (using remote* functions from team-client.ts)
 *  - Provides no-op stubs for server-only concerns (analytics, search, etc.)
 *    since those routes are handled by the server directly
 *  - Uses the wsBroker for local WebSocket event delivery
 */

import { ok, err } from 'neverthrow';

import type { RuntimeServiceProvider } from './service-provider.js';
import { wsBroker } from './ws-broker.js';

function notAvailable(method: string): never {
  throw new Error(`${method} is not available in runner mode — this is a server concern`);
}

export function createRunnerServiceProvider(): RuntimeServiceProvider {
  return {
    // ── Threads — proxy to server via team-client ────────────
    threads: {
      async getThread(id) {
        const { remoteGetThread } = await import('./team-client.js');
        return remoteGetThread(id);
      },
      async updateThread(id, updates) {
        const { remoteUpdateThread } = await import('./team-client.js');
        return remoteUpdateThread(id, updates);
      },
      async getThreadWithMessages(_id) {
        // Read-heavy — forwarded via HTTP tunnel, not here
        return null;
      },
      async listThreads() {
        return [];
      },
      async listArchivedThreads() {
        return [];
      },
      async getThreadByExternalRequestId() {
        return undefined;
      },
      async createThread(data) {
        const { remoteCreateThread } = await import('./team-client.js');
        return remoteCreateThread(data);
      },
      async deleteThread(id) {
        const { remoteDeleteThread } = await import('./team-client.js');
        return remoteDeleteThread(id);
      },
      async markStaleThreadsInterrupted() {},
      async markStaleExternalThreadsStopped() {},
      async getThreadMessages() {
        return [];
      },
      async insertMessage(data) {
        const { remoteInsertMessage } = await import('./team-client.js');
        return remoteInsertMessage(data);
      },
      async updateMessage(id, content) {
        const { remoteUpdateMessage } = await import('./team-client.js');
        return remoteUpdateMessage(id, content);
      },
      async insertToolCall(data) {
        const { remoteInsertToolCall } = await import('./team-client.js');
        return remoteInsertToolCall(data);
      },
      async updateToolCallOutput(id, output) {
        const { remoteUpdateToolCallOutput } = await import('./team-client.js');
        return remoteUpdateToolCallOutput(id, output);
      },
      async findToolCall(messageId, name, input) {
        const { remoteFindToolCall } = await import('./team-client.js');
        return remoteFindToolCall(messageId, name, input);
      },
      async getToolCall(id) {
        const { remoteGetToolCall } = await import('./team-client.js');
        return remoteGetToolCall(id);
      },
      async findLastUnansweredInteractiveToolCall() {
        return undefined;
      },
      async insertComment() {
        return {};
      },
      async listComments() {
        return [];
      },
      async deleteComment() {},
      async getCommentCounts() {
        return {};
      },
      async searchThreadIdsByContent() {
        return new Map();
      },
    },

    // ── Projects — proxy reads to server, writes handled by server routes ──
    projects: {
      async listProjects(userId) {
        const { remoteListProjects } = await import('./team-client.js');
        return remoteListProjects(userId);
      },
      async listProjectsByOrg() {
        return [];
      },
      async isProjectInOrg() {
        return false;
      },
      async getProject(id) {
        const { remoteGetProject } = await import('./team-client.js');
        return remoteGetProject(id);
      },
      async projectNameExists() {
        return false;
      },
      async createProject() {
        notAvailable('createProject');
      },
      async updateProject() {
        notAvailable('updateProject');
      },
      async deleteProject() {},
      async addProjectToOrg() {},
      async getMemberLocalPath() {
        return null;
      },
      async resolveProjectPath(projectId, userId) {
        const { remoteResolveProjectPath } = await import('./team-client.js');
        const result = await remoteResolveProjectPath(projectId, userId);
        if (result.ok && result.path) return ok(result.path);
        return err({
          type: 'BAD_REQUEST' as const,
          message: result.error || 'Failed to resolve project path',
        });
      },
      async reorderProjects() {
        notAvailable('reorderProjects');
      },
    },

    // ── Server-only concerns — handled by server routes directly ──
    automations: {
      async listAutomations() {
        return [];
      },
      async getAutomation() {
        return undefined;
      },
      async insertAutomation() {},
      async createAutomation() {
        notAvailable('createAutomation');
      },
      async updateAutomationRow() {},
      async updateAutomation() {},
      async deleteAutomationRow() {},
      async deleteAutomation() {},
      async createRun() {},
      async updateRun() {},
      async listRuns() {
        return [];
      },
      async listRunningRuns() {
        return [];
      },
      async getRunByThreadId() {
        return undefined;
      },
      async listPendingReviewRuns() {
        return [];
      },
      async listInboxRuns() {
        return [];
      },
    },

    pipelines: {
      async getPipelineForProject() {
        return null;
      },
      async createPipeline() {
        return '';
      },
      async getPipelineById() {
        return undefined;
      },
      async getPipelinesByProject() {
        return [];
      },
      async updatePipeline() {},
      async deletePipeline() {},
      async createRun() {
        return '';
      },
      async updateRun() {},
      async getRunById() {
        return undefined;
      },
      async getRunsForThread() {
        return [];
      },
    },

    profile: {
      async getProfile(userId) {
        const { remoteGetProfile } = await import('./team-client.js');
        return remoteGetProfile(userId);
      },
      async getGithubToken(userId) {
        const { remoteGetGithubToken } = await import('./team-client.js');
        return remoteGetGithubToken(userId);
      },
      async getAssemblyaiApiKey() {
        return null;
      },
      async getGitIdentity(userId) {
        const { remoteGetProfile } = await import('./team-client.js');
        const profile = await remoteGetProfile(userId);
        if (profile?.gitName && profile?.gitEmail) {
          return { name: profile.gitName, email: profile.gitEmail };
        }
        return null;
      },
      async isSetupCompleted(userId) {
        const { remoteGetProfile } = await import('./team-client.js');
        const profile = await remoteGetProfile(userId);
        return !!profile?.setupCompleted;
      },
      async updateProfile(userId, data) {
        const { remoteUpdateProfile } = await import('./team-client.js');
        return remoteUpdateProfile(userId, data);
      },
    },

    analytics: {
      async getOverview() {
        return {};
      },
      async getTimeline() {
        return {};
      },
    },

    search: {
      async searchThreadIdsByContent() {
        return new Map();
      },
    },

    startupCommands: {
      async listCommands() {
        return [];
      },
      async createCommand() {
        return {};
      },
      async updateCommand() {},
      async deleteCommand() {},
      async getCommand() {
        return undefined;
      },
    },

    threadEvents: {
      async createThreadEvent() {},
      async saveThreadEvent(threadId: string, type: string, data: Record<string, unknown>) {
        const { remoteSaveThreadEvent } = await import('./team-client.js');
        await remoteSaveThreadEvent(threadId, type, data);
      },
      async getThreadEvents() {
        return [];
      },
      async deleteThreadEvents() {},
    },

    messageQueue: {
      async enqueue(threadId, data) {
        const { remoteEnqueueMessage } = await import('./team-client.js');
        return remoteEnqueueMessage(threadId, data);
      },
      async peek(threadId) {
        const { remotePeekMessage } = await import('./team-client.js');
        return remotePeekMessage(threadId);
      },
      async dequeue(threadId) {
        const { remoteDequeueMessage } = await import('./team-client.js');
        return remoteDequeueMessage(threadId);
      },
      async cancel(messageId) {
        const { remoteCancelQueuedMessage } = await import('./team-client.js');
        return remoteCancelQueuedMessage(messageId);
      },
      async update(messageId, content) {
        const { remoteUpdateQueuedMessage } = await import('./team-client.js');
        return remoteUpdateQueuedMessage(messageId, content);
      },
      async listQueue(threadId) {
        const { remoteListQueue } = await import('./team-client.js');
        return remoteListQueue(threadId);
      },
      async queueCount(threadId) {
        const { remoteQueueCount } = await import('./team-client.js');
        return remoteQueueCount(threadId);
      },
      async clearQueue() {},
    },

    mcpOauth: {
      async startOAuthFlow() {
        notAvailable('startOAuthFlow');
      },
      async handleOAuthCallback() {
        return { serverName: '', success: false, error: 'Not available in runner mode' };
      },
      async upsertToken() {},
    },

    stageHistory: {
      async recordStageChange() {},
    },

    arcs: {
      async getArc(id) {
        const { remoteGetArc } = await import('./team-client.js');
        return remoteGetArc(id);
      },
    },

    wsBroker,
  };
}
