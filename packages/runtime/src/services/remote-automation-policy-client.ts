import type { PendingPermissionRequest, PermissionDecision } from '@funny/shared';
import type { DataCreatePendingPermissionRequest } from '@funny/shared/runner-protocol';

import { sendRemoteData } from './remote-data-channel.js';
import type { RemoteDataRequest } from './remote-thread-data-client.js';

/** Remote permissions, watcher, and detached-job persistence client. */
export class RemoteAutomationPolicyClient {
  constructor(private readonly request: RemoteDataRequest) {}

  async createPendingPermissionRequest(
    payload: DataCreatePendingPermissionRequest['payload'] | PendingPermissionRequest,
  ): Promise<void> {
    await this.request('data:create_pending_permission_request', { payload });
  }
  async resolvePendingPermissionRequest(
    requestId: string,
    decision: PermissionDecision,
  ): Promise<boolean> {
    return (
      (
        await this.request('data:resolve_pending_permission_request', {
          payload: { requestId, decision },
        })
      )?.success === true
    );
  }
  async expirePendingPermissionRequest(requestId: string): Promise<void> {
    await this.request('data:expire_pending_permission_request', { payload: { requestId } });
  }
  async insertWatcher(row: Record<string, any>): Promise<void> {
    await this.request('data:watcher_insert', { payload: { threadId: row.threadId, row } });
  }
  async getWatcher(id: string) {
    return (await this.request('data:watcher_get', { payload: { id } }))?.watcher ?? undefined;
  }
  async getLiveWatcherByThreadKey(threadId: string, key: string) {
    return (
      (
        await this.request('data:watcher_get_live_by_thread_key', {
          payload: { threadId, key },
        })
      )?.watcher ?? undefined
    );
  }
  async listPendingWatchers(): Promise<any[]> {
    return (await this.request('data:watcher_list_pending', { payload: {} }))?.watchers ?? [];
  }
  async listDueWatchers(now: number): Promise<any[]> {
    return (await this.request('data:watcher_list_due', { payload: { now } }))?.watchers ?? [];
  }
  async listWatchersByUser(userId: string): Promise<any[]> {
    return (
      (await this.request('data:watcher_list_by_user', { payload: { userId } }))?.watchers ?? []
    );
  }
  async updateWatcher(id: string, patch: Record<string, any>): Promise<void> {
    await this.request('data:watcher_update', { payload: { id, patch } });
  }
  async deleteWatchersByThread(threadId: string): Promise<void> {
    await this.request('data:watcher_delete_by_thread', { payload: { threadId } });
  }
  async insertJob(row: Record<string, any>): Promise<void> {
    await this.request('data:job_insert', { payload: { threadId: row.threadId, row } });
  }
  async getJob(id: string) {
    return (await this.request('data:job_get', { payload: { id } }))?.job ?? undefined;
  }
  async listRunningJobs(): Promise<any[]> {
    return (await this.request('data:job_list_running', { payload: {} }))?.jobs ?? [];
  }
  async listJobsByUser(userId: string): Promise<any[]> {
    return (await this.request('data:job_list_by_user', { payload: { userId } }))?.jobs ?? [];
  }
  async updateJob(id: string, patch: Record<string, any>): Promise<void> {
    await this.request('data:job_update', { payload: { id, patch } });
  }
  async deleteJobsByThread(threadId: string): Promise<void> {
    await this.request('data:job_delete_by_thread', { payload: { threadId } });
  }
  async createPermissionRule(input: {
    userId: string;
    projectPath: string;
    toolName: string;
    pattern: string | null;
    decision: 'allow' | 'deny';
  }) {
    return (await this.request('data:create_permission_rule', { payload: input }))?.rule ?? null;
  }
  async findPermissionRule(query: {
    userId: string;
    projectPath: string;
    toolName: string;
    toolInput?: string;
  }) {
    return (await this.request('data:find_permission_rule', { payload: query }))?.rule ?? null;
  }
  async listPermissionRules(query: { userId: string; projectPath?: string }): Promise<any[]> {
    return (await this.request('data:list_permission_rules', { payload: query }))?.rules ?? [];
  }
}

export const remoteAutomationPolicyClient = new RemoteAutomationPolicyClient(sendRemoteData);

export const remoteCreatePendingPermissionRequest =
  remoteAutomationPolicyClient.createPendingPermissionRequest.bind(remoteAutomationPolicyClient);
export const remoteResolvePendingPermissionRequest =
  remoteAutomationPolicyClient.resolvePendingPermissionRequest.bind(remoteAutomationPolicyClient);
export const remoteExpirePendingPermissionRequest =
  remoteAutomationPolicyClient.expirePendingPermissionRequest.bind(remoteAutomationPolicyClient);
export const remoteInsertWatcher = remoteAutomationPolicyClient.insertWatcher.bind(
  remoteAutomationPolicyClient,
);
export const remoteGetWatcher = remoteAutomationPolicyClient.getWatcher.bind(
  remoteAutomationPolicyClient,
);
export const remoteGetLiveWatcherByThreadKey =
  remoteAutomationPolicyClient.getLiveWatcherByThreadKey.bind(remoteAutomationPolicyClient);
export const remoteListPendingWatchers = remoteAutomationPolicyClient.listPendingWatchers.bind(
  remoteAutomationPolicyClient,
);
export const remoteListDueWatchers = remoteAutomationPolicyClient.listDueWatchers.bind(
  remoteAutomationPolicyClient,
);
export const remoteListWatchersByUser = remoteAutomationPolicyClient.listWatchersByUser.bind(
  remoteAutomationPolicyClient,
);
export const remoteUpdateWatcher = remoteAutomationPolicyClient.updateWatcher.bind(
  remoteAutomationPolicyClient,
);
export const remoteDeleteWatchersByThread =
  remoteAutomationPolicyClient.deleteWatchersByThread.bind(remoteAutomationPolicyClient);
export const remoteInsertJob = remoteAutomationPolicyClient.insertJob.bind(
  remoteAutomationPolicyClient,
);
export const remoteGetJob = remoteAutomationPolicyClient.getJob.bind(remoteAutomationPolicyClient);
export const remoteListRunningJobs = remoteAutomationPolicyClient.listRunningJobs.bind(
  remoteAutomationPolicyClient,
);
export const remoteListJobsByUser = remoteAutomationPolicyClient.listJobsByUser.bind(
  remoteAutomationPolicyClient,
);
export const remoteUpdateJob = remoteAutomationPolicyClient.updateJob.bind(
  remoteAutomationPolicyClient,
);
export const remoteDeleteJobsByThread = remoteAutomationPolicyClient.deleteJobsByThread.bind(
  remoteAutomationPolicyClient,
);
export const remoteCreatePermissionRule = remoteAutomationPolicyClient.createPermissionRule.bind(
  remoteAutomationPolicyClient,
);
export const remoteFindPermissionRule = remoteAutomationPolicyClient.findPermissionRule.bind(
  remoteAutomationPolicyClient,
);
export const remoteListPermissionRules = remoteAutomationPolicyClient.listPermissionRules.bind(
  remoteAutomationPolicyClient,
);
