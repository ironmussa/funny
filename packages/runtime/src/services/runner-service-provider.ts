/**
 * Service provider for the runtime runner.
 *
 * The runtime is always a remote runner connected to the central server.
 * This is the ONLY service provider — there is no in-process alternative.
 *
 * This provider:
 *  - Proxies thread/message/toolcall/project/profile ops through narrow
 *    domain clients over the shared gRPC data channel
 *  - Provides no-op stubs for server-only concerns (analytics, search, etc.)
 *    since those routes are handled by the server directly
 *  - Uses the wsBroker for local WebSocket event delivery
 */

import { internal } from '@funny/shared/errors';
import { ok, err, errAsync } from 'neverthrow';

import type { RuntimeServiceProvider } from './service-provider.js';
import { wsBroker } from './ws-broker.js';

function notAvailable(method: string): never {
  throw new Error(`${method} is not available in runner mode — this is a server concern`);
}

export function createRunnerServiceProvider(): RuntimeServiceProvider {
  return {
    // ── Threads — proxy to server via remote data client ─────
    threads: {
      async getThread(id) {
        const { remoteGetThread } = await import('./remote-thread-data-client.js');
        return remoteGetThread(id);
      },
      async updateThread(id, updates) {
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
      async getThreadWithMessages(id, messageLimit, opts) {
        const { remoteGetThreadWithMessages } = await import('./remote-thread-data-client.js');
        return remoteGetThreadWithMessages(id, messageLimit, opts);
      },
      async listThreads(opts) {
        if (!opts.projectId || opts.includeArchived || opts.isScratch === true) {
          return { threads: [], total: 0 };
        }
        const { remoteListProjectThreads } = await import('./remote-project-identity-client.js');
        const allThreads = await remoteListProjectThreads(opts.projectId);
        const offset = opts.offset ?? 0;
        const threads =
          opts.limit === undefined
            ? allThreads.slice(offset)
            : allThreads.slice(offset, offset + opts.limit);
        return { threads, total: allThreads.length };
      },
      async listArchivedThreads() {
        return [];
      },
      async getThreadByExternalRequestId(externalRequestId) {
        const { remoteGetThreadByExternalRequestId } =
          await import('./remote-thread-data-client.js');
        return remoteGetThreadByExternalRequestId(externalRequestId);
      },
      async getThreadBySessionId(sessionId) {
        const { remoteGetThreadBySessionId } = await import('./remote-thread-data-client.js');
        return remoteGetThreadBySessionId(sessionId);
      },
      async createThread(data) {
        const { remoteCreateThread } = await import('./remote-thread-data-client.js');
        return remoteCreateThread(data);
      },
      async deleteThread(id) {
        const { remoteDeleteThread } = await import('./remote-thread-data-client.js');
        return remoteDeleteThread(id);
      },
      async markStaleThreadsInterrupted() {},
      async markStaleExternalThreadsStopped() {},
      async markAndListStaleThreads() {
        return [];
      },
      async getThreadMessages(opts) {
        const { remoteGetThreadMessages } = await import('./remote-thread-data-client.js');
        return remoteGetThreadMessages(opts);
      },
      async insertMessage(data) {
        const { remoteInsertMessage } = await import('./remote-thread-data-client.js');
        return remoteInsertMessage(data);
      },
      async updateMessage(id, content) {
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
      async updateToolCallOutput(id, output) {
        const { remoteUpdateToolCallOutput } = await import('./remote-thread-data-client.js');
        return remoteUpdateToolCallOutput(id, output);
      },
      async findToolCall(messageId, name, input) {
        const { remoteFindToolCall } = await import('./remote-thread-data-client.js');
        return remoteFindToolCall(messageId, name, input);
      },
      async getToolCall(id) {
        const { remoteGetToolCall } = await import('./remote-thread-data-client.js');
        return remoteGetToolCall(id);
      },
      async findLastUnansweredInteractiveToolCall(threadId: string) {
        const { remoteFindLastUnansweredInteractiveToolCall } =
          await import('./remote-thread-data-client.js');
        return remoteFindLastUnansweredInteractiveToolCall(threadId);
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
        const { remoteListProjects } = await import('./remote-project-identity-client.js');
        return remoteListProjects(userId);
      },
      async listProjectsByOrg() {
        return [];
      },
      async isProjectInOrg() {
        return false;
      },
      async getProject(id) {
        const { remoteGetProject } = await import('./remote-project-identity-client.js');
        return remoteGetProject(id);
      },
      async projectNameExists() {
        return false;
      },
      async createProject(name, path, userId, orgId) {
        const { remoteCreateProject } = await import('./remote-project-identity-client.js');
        const response = await remoteCreateProject(name, path, userId, orgId);
        if (response?.error) {
          return err({
            type: (response.errorType as 'BAD_REQUEST' | 'CONFLICT' | 'INTERNAL') || 'INTERNAL',
            message: response.error,
          });
        }
        return ok(response.project);
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
        const { remoteResolveProjectPath } = await import('./remote-project-identity-client.js');
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
        const { remoteGetProfile } = await import('./remote-project-identity-client.js');
        return remoteGetProfile(userId);
      },
      async getProviderKey(userId, provider) {
        const { remoteGetProviderKey } = await import('./remote-project-identity-client.js');
        return remoteGetProviderKey(userId, provider);
      },
      async getGithubToken(userId) {
        const { remoteGetProviderKey } = await import('./remote-project-identity-client.js');
        return remoteGetProviderKey(userId, 'github');
      },
      async getAssemblyaiApiKey(userId) {
        const { remoteGetProviderKey } = await import('./remote-project-identity-client.js');
        return remoteGetProviderKey(userId, 'assemblyai');
      },
      async getMinimaxApiKey(userId) {
        const { remoteGetProviderKey } = await import('./remote-project-identity-client.js');
        return remoteGetProviderKey(userId, 'minimax');
      },
      async getGitIdentity(userId) {
        const { remoteGetProfile } = await import('./remote-project-identity-client.js');
        const profile = await remoteGetProfile(userId);
        if (profile?.gitName && profile?.gitEmail) {
          return { name: profile.gitName, email: profile.gitEmail };
        }
        return null;
      },
      async isSetupCompleted(userId) {
        const { remoteGetProfile } = await import('./remote-project-identity-client.js');
        const profile = await remoteGetProfile(userId);
        return !!profile?.setupCompleted;
      },
      async updateProfile(userId, data) {
        const { remoteUpdateProfile } = await import('./remote-project-identity-client.js');
        return remoteUpdateProfile(userId, data);
      },
    },

    agentProfiles: {
      async resolveEffectiveProfile(projectId, userId) {
        const { remoteResolveAgentExecutionProfile } =
          await import('./remote-project-identity-client.js');
        return remoteResolveAgentExecutionProfile(projectId, userId);
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
      async getCommand(cmdId, projectId) {
        const { remoteGetStartupCommand } = await import('./remote-project-identity-client.js');
        return remoteGetStartupCommand(cmdId, projectId);
      },
    },

    threadEvents: {
      async createThreadEvent() {},
      async saveThreadEvent(threadId: string, type: string, data: Record<string, unknown>) {
        const { remoteSaveThreadEvent } = await import('./remote-thread-data-client.js');
        await remoteSaveThreadEvent(threadId, type, data);
      },
      async getThreadEvents() {
        return [];
      },
      async deleteThreadEvents() {},
    },

    messageQueue: {
      async enqueue(threadId, data) {
        const { remoteEnqueueMessage } = await import('./remote-thread-data-client.js');
        return remoteEnqueueMessage(threadId, data);
      },
      async peek(threadId) {
        const { remotePeekMessage } = await import('./remote-thread-data-client.js');
        return remotePeekMessage(threadId);
      },
      async dequeue(threadId) {
        const { remoteDequeueMessage } = await import('./remote-thread-data-client.js');
        return remoteDequeueMessage(threadId);
      },
      async cancel(messageId) {
        const { remoteCancelQueuedMessage } = await import('./remote-thread-data-client.js');
        return remoteCancelQueuedMessage(messageId);
      },
      async update(messageId, content) {
        const { remoteUpdateQueuedMessage } = await import('./remote-thread-data-client.js');
        return remoteUpdateQueuedMessage(messageId, content);
      },
      async listQueue(threadId) {
        const { remoteListQueue } = await import('./remote-thread-data-client.js');
        return remoteListQueue(threadId);
      },
      async queueCount(threadId) {
        const { remoteQueueCount } = await import('./remote-thread-data-client.js');
        return remoteQueueCount(threadId);
      },
      async clearQueue() {},
    },

    mcpOauth: {
      startOAuthFlow() {
        return errAsync(internal('startOAuthFlow is not available in runner mode'));
      },
      async handleOAuthCallback() {
        return {
          serverName: '',
          success: false,
          error: 'Not available in runner mode',
        };
      },
      async upsertToken() {},
    },

    stageHistory: {
      async recordStageChange() {},
    },

    // ── Agent watchers — proxy via automation/policy client ───
    watchers: {
      async insertWatcher(row) {
        const { remoteInsertWatcher } = await import('./remote-automation-policy-client.js');
        return remoteInsertWatcher(row);
      },
      async getWatcher(id) {
        const { remoteGetWatcher } = await import('./remote-automation-policy-client.js');
        return remoteGetWatcher(id);
      },
      async getLiveWatcherByThreadKey(threadId, key) {
        const { remoteGetLiveWatcherByThreadKey } =
          await import('./remote-automation-policy-client.js');
        return remoteGetLiveWatcherByThreadKey(threadId, key);
      },
      async listPendingWatchers() {
        const { remoteListPendingWatchers } = await import('./remote-automation-policy-client.js');
        return remoteListPendingWatchers();
      },
      async listDueWatchers(now) {
        const { remoteListDueWatchers } = await import('./remote-automation-policy-client.js');
        return remoteListDueWatchers(now);
      },
      async listWatchersByUser(userId) {
        const { remoteListWatchersByUser } = await import('./remote-automation-policy-client.js');
        return remoteListWatchersByUser(userId);
      },
      async updateWatcher(id, patch) {
        const { remoteUpdateWatcher } = await import('./remote-automation-policy-client.js');
        return remoteUpdateWatcher(id, patch);
      },
      async deleteWatchersByThread(threadId) {
        const { remoteDeleteWatchersByThread } =
          await import('./remote-automation-policy-client.js');
        return remoteDeleteWatchersByThread(threadId);
      },
    },

    // ── Agent jobs — proxy via automation/policy client ───────
    jobs: {
      async insertJob(row) {
        const { remoteInsertJob } = await import('./remote-automation-policy-client.js');
        return remoteInsertJob(row);
      },
      async getJob(id) {
        const { remoteGetJob } = await import('./remote-automation-policy-client.js');
        return remoteGetJob(id);
      },
      async listRunningJobs() {
        const { remoteListRunningJobs } = await import('./remote-automation-policy-client.js');
        return remoteListRunningJobs();
      },
      async listJobsByUser(userId) {
        const { remoteListJobsByUser } = await import('./remote-automation-policy-client.js');
        return remoteListJobsByUser(userId);
      },
      async updateJob(id, patch) {
        const { remoteUpdateJob } = await import('./remote-automation-policy-client.js');
        return remoteUpdateJob(id, patch);
      },
      async deleteJobsByThread(threadId) {
        const { remoteDeleteJobsByThread } = await import('./remote-automation-policy-client.js');
        return remoteDeleteJobsByThread(threadId);
      },
    },

    wsBroker,
  };
}
