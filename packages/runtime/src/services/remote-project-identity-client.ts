import type { Project, ResolvedAgentExecutionProfileResponse } from '@funny/shared';

import { sendRemoteData } from './remote-data-channel.js';
import type { RemoteDataRequest } from './remote-thread-data-client.js';

/** Remote project, profile, credential, and provider-selection client. */
export class RemoteProjectIdentityClient {
  private readonly projectCache = new Map<string, { value: any; expiry: number }>();
  private readonly projectInflight = new Map<string, Promise<any>>();

  constructor(
    private readonly request: RemoteDataRequest,
    private readonly assigned: (project: Project) => Promise<void>,
    private readonly now: () => number = Date.now,
  ) {}

  async getProject(projectId: string): Promise<any> {
    const cached = this.projectCache.get(projectId);
    if (cached && this.now() < cached.expiry) return cached.value;
    const inflight = this.projectInflight.get(projectId);
    if (inflight) return inflight;
    const promise = this.request('data:get_project', { projectId })
      .then((response) => {
        const project = response?.project ?? null;
        this.projectCache.set(projectId, { value: project, expiry: this.now() + 30_000 });
        return project;
      })
      .finally(() => this.projectInflight.delete(projectId));
    this.projectInflight.set(projectId, promise);
    return promise;
  }

  invalidateProject(projectId: string): void {
    this.projectCache.delete(projectId);
  }

  async getStartupCommand(commandId: string, projectId: string): Promise<any> {
    return (
      (await this.request('data:get_startup_command', { cmdId: commandId, projectId }))?.command ??
      null
    );
  }
  async listProjects(userId: string): Promise<any[]> {
    const result = await this.request('data:list_projects', { userId });
    return result?.projects ?? result ?? [];
  }
  async listProjectThreads(projectId: string): Promise<any[]> {
    return (await this.request('data:list_project_threads', { projectId }))?.threads ?? [];
  }
  resolveProjectPath(projectId: string, userId: string) {
    return this.request('data:resolve_project_path', { projectId, userId });
  }
  async getProfile(userId: string): Promise<any> {
    return (await this.request('data:get_profile', { userId }))?.profile ?? null;
  }
  async getProviderKey(userId: string, provider: string): Promise<string | null> {
    return (await this.request('data:get_provider_key', { userId, provider }))?.key ?? null;
  }
  getGithubToken(userId: string): Promise<string | null> {
    return this.getProviderKey(userId, 'github');
  }
  getMinimaxApiKey(userId: string): Promise<string | null> {
    return this.getProviderKey(userId, 'minimax');
  }
  async updateProfile(userId: string, data: Record<string, any>): Promise<any> {
    return (await this.request('data:update_profile', { userId, payload: data }))?.profile ?? null;
  }
  async resolveAgentExecutionProfile(
    projectId: string,
    userId: string,
  ): Promise<ResolvedAgentExecutionProfileResponse> {
    const response = await this.request('data:resolve_agent_execution_profile', {
      projectId,
      userId,
    });
    return {
      profile: response?.profile ?? null,
      env: response?.env && typeof response.env === 'object' ? response.env : {},
    };
  }
  async createProject(
    name: string,
    path: string,
    userId: string,
    orgId?: string | null,
  ): Promise<any> {
    const response = await this.request('data:create_project', {
      name,
      path,
      userId,
      orgId: orgId ?? null,
    });
    if (response?.project && !response.error) await this.assigned(response.project);
    return response;
  }
  async getActiveBuiltinProviders(): Promise<string[] | null> {
    const response = await this.request('data:get_builtin_providers', {});
    return Array.isArray(response?.active) ? response.active : null;
  }
  async setActiveBuiltinProviders(active: string[]): Promise<void> {
    await this.request('data:set_builtin_providers', { active });
  }
}

let projectAssigned: (project: Project) => Promise<void> = async () => {};
export function configureRemoteProjectAssignment(
  handler: (project: Project) => Promise<void>,
): void {
  projectAssigned = handler;
}
export const remoteProjectIdentityClient = new RemoteProjectIdentityClient(
  sendRemoteData,
  (project) => projectAssigned(project),
);

export const remoteGetProject = remoteProjectIdentityClient.getProject.bind(
  remoteProjectIdentityClient,
);
export const invalidateProjectCache = remoteProjectIdentityClient.invalidateProject.bind(
  remoteProjectIdentityClient,
);
export const remoteGetStartupCommand = remoteProjectIdentityClient.getStartupCommand.bind(
  remoteProjectIdentityClient,
);
export const remoteListProjects = remoteProjectIdentityClient.listProjects.bind(
  remoteProjectIdentityClient,
);
export const remoteListProjectThreads = remoteProjectIdentityClient.listProjectThreads.bind(
  remoteProjectIdentityClient,
);
export const remoteResolveProjectPath = remoteProjectIdentityClient.resolveProjectPath.bind(
  remoteProjectIdentityClient,
);
export const remoteGetProfile = remoteProjectIdentityClient.getProfile.bind(
  remoteProjectIdentityClient,
);
export const remoteGetProviderKey = remoteProjectIdentityClient.getProviderKey.bind(
  remoteProjectIdentityClient,
);
export const remoteGetGithubToken = remoteProjectIdentityClient.getGithubToken.bind(
  remoteProjectIdentityClient,
);
export const remoteGetMinimaxApiKey = remoteProjectIdentityClient.getMinimaxApiKey.bind(
  remoteProjectIdentityClient,
);
export const remoteUpdateProfile = remoteProjectIdentityClient.updateProfile.bind(
  remoteProjectIdentityClient,
);
export const remoteResolveAgentExecutionProfile =
  remoteProjectIdentityClient.resolveAgentExecutionProfile.bind(remoteProjectIdentityClient);
export const remoteCreateProject = remoteProjectIdentityClient.createProject.bind(
  remoteProjectIdentityClient,
);
export const remoteGetActiveBuiltinProviders =
  remoteProjectIdentityClient.getActiveBuiltinProviders.bind(remoteProjectIdentityClient);
export const remoteSetActiveBuiltinProviders =
  remoteProjectIdentityClient.setActiveBuiltinProviders.bind(remoteProjectIdentityClient);
