import type {
  AuthSessionState,
  StoreApi,
  ThreadNavigationState,
  ThreadWorkspaceState,
} from '@funny/client-core';
import type {
  GitStatusInfo,
  PaginatedMessages,
  PaginatedThreadsResponse,
  Project,
  ThreadWithMessages,
} from '@funny/shared';

import type { NativeGitStatusState } from '../git-status-state';
import type { NativeClientComposition } from '../platform/composition';
import type { NativeAuthService } from './auth';
import { NativeApiError, nativeJsonRequest } from './native-api';

export class NativeThreadDataService {
  constructor(
    private readonly options: {
      composition: NativeClientComposition;
      auth: NativeAuthService;
      authState: StoreApi<AuthSessionState>;
      navigation: StoreApi<ThreadNavigationState>;
      workspace: StoreApi<ThreadWorkspaceState>;
      gitStatus: StoreApi<NativeGitStatusState>;
    },
  ) {}

  async loadNavigation(): Promise<void> {
    const organizationId = this.options.authState.getState().activeOrganization?.id;
    const projects = await this.request<Project[]>(
      `/projects${organizationId ? `?orgId=${encodeURIComponent(organizationId)}` : ''}`,
    );
    this.options.navigation.getState().replaceProjects(projects);
    await Promise.all([
      ...projects.map(async (project) => {
        const page = await this.request<PaginatedThreadsResponse>(
          `/threads?projectId=${encodeURIComponent(project.id)}&limit=100`,
        );
        this.options.navigation
          .getState()
          .replaceProjectThreads(project.id, page.threads, page.total);
      }),
      this.loadScratchThreads(),
      this.loadSharedThreads(),
    ]);
    void this.loadGitStatuses(projects.map((project) => project.id));
  }

  async loadScratchThreads(): Promise<void> {
    const page = await this.request<PaginatedThreadsResponse>('/threads/scratch?limit=100');
    this.options.navigation.getState().replaceScratchThreads(page.threads, page.total);
  }

  async loadSharedThreads(): Promise<void> {
    const page = await this.request<{ threads: ThreadWithMessages[] }>('/threads/shared-with-me');
    this.options.navigation.getState().replaceSharedThreads(page.threads, page.threads.length);
  }

  async loadProjectGitStatus(projectId: string): Promise<void> {
    try {
      const response = await this.request<{ statuses?: GitStatusInfo[] }>(
        `/git/status?projectId=${encodeURIComponent(projectId)}`,
      );
      if (Array.isArray(response.statuses)) {
        this.options.gitStatus.getState().replace(response.statuses);
      }
    } catch (error) {
      this.options.composition.platform.diagnostics.report({
        capability: 'transport',
        operation: 'git-status.request',
        error,
      });
    }
  }

  async loadGitStatuses(projectIds: readonly string[]): Promise<void> {
    await Promise.all(projectIds.map((projectId) => this.loadProjectGitStatus(projectId)));
  }

  async selectThread(threadId: string): Promise<boolean> {
    this.options.workspace.getState().selectThread(threadId);
    this.options.workspace.getState().setLoading(threadId, true);
    try {
      const thread = await this.request<ThreadWithMessages>(
        `/threads/${encodeURIComponent(threadId)}?messageLimit=100`,
      );
      this.options.navigation.getState().patchThread(threadId, thread);
      this.options.workspace.getState().replaceInitialPage(threadId, {
        messages: thread.messages,
        hasMore: thread.hasMore ?? false,
        hasMoreAfter: thread.hasMoreAfter,
        total: thread.total,
        windowStart: thread.windowStart,
      });
      this.options.workspace.getState().setRun(threadId, {
        status: thread.status,
        runId: thread.pendingPermissionRequest?.runId ?? null,
      });
      this.options.workspace
        .getState()
        .setPermission(
          threadId,
          thread.pendingPermissionRequest
            ? { ...thread.pendingPermissionRequest, status: 'active' }
            : null,
        );
      this.navigateToThread(threadId);
      return true;
    } catch (error) {
      this.options.workspace.getState().setError(threadId, this.errorMessage(error));
      return false;
    }
  }

  async loadOlder(threadId: string): Promise<boolean> {
    const data = this.options.workspace.getState().byThreadId[threadId];
    const cursor = data?.messageIds[0];
    if (!cursor || !data.hasMore || data.loading) return false;
    this.options.workspace.getState().setLoading(threadId, true);
    try {
      const page = await this.request<PaginatedMessages>(
        `/threads/${encodeURIComponent(threadId)}/messages?cursor=${encodeURIComponent(cursor)}&limit=50&direction=before`,
      );
      this.options.workspace.getState().prependOlderPage(threadId, page);
      return true;
    } catch (error) {
      this.options.workspace.getState().setError(threadId, this.errorMessage(error));
      return false;
    }
  }

  async resyncSelected(): Promise<void> {
    const threadId = this.options.workspace.getState().selectedThreadId;
    if (threadId) await this.selectThread(threadId);
  }

  private navigateToThread(threadId: string): void {
    const thread = this.options.navigation.getState().threadsById[threadId];
    const pathname =
      thread?.isScratch || !thread?.projectId
        ? `/scratch/${encodeURIComponent(threadId)}`
        : `/projects/${encodeURIComponent(thread.projectId)}/threads/${encodeURIComponent(threadId)}`;
    this.options.composition.navigation.navigate({
      pathname,
      search: '',
      hash: '',
    });
  }

  private errorMessage(error: unknown): string {
    this.options.composition.platform.diagnostics.report({
      capability: 'transport',
      operation: 'thread-data.request',
      error,
    });
    if (error instanceof NativeApiError && error.status === 401) this.options.auth.rejectSession();
    if (error instanceof NativeApiError && error.status === 403) return 'Access denied';
    return error instanceof Error ? error.message : String(error);
  }

  private request<T>(path: string): Promise<T> {
    return nativeJsonRequest<T>({
      platform: this.options.composition.platform,
      path,
      clientOrigin: this.options.composition.clientOrigin,
    });
  }
}
