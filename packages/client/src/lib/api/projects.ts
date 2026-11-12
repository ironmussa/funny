import type {
  FunnyProjectConfig,
  HookType,
  Project,
  ProjectHook,
  ProjectUpdateFields,
  WeaveStatus,
} from '@funny/shared';
import type { ProjectMemberEntry, UpdateProjectBody } from '@funny/shared/contracts/projects';

import { request } from './_core';
import { trpc, trpcCall } from './_trpc';

export type { ProjectMemberEntry };

const procedures = trpc.projects;

/** Fields a project PATCH accepts. */
export type UpdateProjectInput = ProjectUpdateFields;

export const projectsApi = {
  // Projects
  listProjects: (orgId?: string | null, search?: string, signal?: AbortSignal) =>
    trpcCall(() =>
      procedures.list.query(
        {
          ...(orgId ? { orgId } : orgId === null ? { personal: true } : {}),
          ...(search !== undefined ? { q: search } : {}),
        },
        { signal },
      ),
    ),
  createProject: (name: string, path: string) =>
    request<Project>('/projects', { method: 'POST', body: JSON.stringify({ name, path }) }),
  renameProject: (id: string, name: string) =>
    trpcCall(() => procedures.update.mutate({ projectId: id, data: { name } })),
  updateProject: (id: string, data: UpdateProjectInput) =>
    // `defaultEffort` is a plain string in the UI's effort pickers; the
    // procedure's schema checks it is a real level (400 otherwise).
    trpcCall(() => procedures.update.mutate({ projectId: id, data: data as UpdateProjectBody })),
  deleteProject: (id: string) => trpcCall(() => procedures.remove.mutate({ projectId: id })),
  reorderProjects: (projectIds: string[]) =>
    trpcCall(() => procedures.reorder.mutate({ projectIds })).map(() => undefined),
  setProjectLocalPath: (projectId: string, localPath: string) =>
    trpcCall(() => procedures.setLocalPath.mutate({ projectId, localPath })),
  listBranches: (projectId: string, signal?: AbortSignal) =>
    request<{
      branches: string[];
      remoteBranches: string[];
      directoryExists?: boolean;
      defaultBranch: string | null;
      currentBranch: string | null;
    }>(`/projects/${projectId}/branches`, { signal }),
  checkoutPreflight: (projectId: string, branch: string) =>
    request<{
      canCheckout: boolean;
      currentBranch: string | null;
      reason?: string;
      hasDirtyFiles?: boolean;
      dirtyFileCount?: number;
      worktreePath?: string;
    }>(`/projects/${projectId}/checkout-preflight?branch=${encodeURIComponent(branch)}`),
  checkout: (
    projectId: string,
    branch: string,
    strategy: 'stash' | 'carry' = 'carry',
    create = false,
    threadId?: string,
  ) =>
    request<{ ok: boolean; currentBranch: string; worktreePath?: string }>(
      `/projects/${projectId}/checkout`,
      {
        method: 'POST',
        body: JSON.stringify({ branch, strategy, create, threadId }),
      },
    ),

  // Startup Commands
  listCommands: (projectId: string) => trpcCall(() => procedures.commands.query({ projectId })),
  addCommand: (projectId: string, label: string, command: string) =>
    trpcCall(() => procedures.createCommand.mutate({ projectId, label, command })),
  updateCommand: (projectId: string, cmdId: string, label: string, command: string) =>
    trpcCall(() =>
      procedures.updateCommand.mutate({ projectId, commandId: cmdId, data: { label, command } }),
    ),
  deleteCommand: (projectId: string, cmdId: string) =>
    trpcCall(() => procedures.deleteCommand.mutate({ projectId, commandId: cmdId })),
  runCommand: (projectId: string, cmdId: string, threadId?: string) =>
    request<{ ok: boolean }>(`/projects/${projectId}/commands/${cmdId}/start`, {
      method: 'POST',
      body: JSON.stringify(threadId ? { threadId } : {}),
    }),
  stopCommand: (projectId: string, cmdId: string) =>
    request<{ ok: boolean }>(`/projects/${projectId}/commands/${cmdId}/stop`, { method: 'POST' }),

  // Project Config (.funny.json)
  getProjectConfig: (projectId: string) =>
    request<FunnyProjectConfig>(`/projects/${projectId}/config`),
  updateProjectConfig: (projectId: string, config: FunnyProjectConfig) =>
    request<{ ok: boolean }>(`/projects/${projectId}/config`, {
      method: 'PUT',
      body: JSON.stringify(config),
    }),

  // Weave Semantic Merge
  getWeaveStatus: (projectId: string) =>
    request<WeaveStatus>(`/projects/${projectId}/weave/status`),
  configureWeave: (projectId: string) =>
    request<{ ok: boolean; status: WeaveStatus }>(`/projects/${projectId}/weave/configure`, {
      method: 'POST',
    }),

  // Project Hooks (Husky-backed)
  listHooks: (projectId: string, hookType?: HookType) =>
    request<ProjectHook[]>(
      `/projects/${projectId}/hooks${hookType ? `?hookType=${hookType}` : ''}`,
    ),
  addHook: (projectId: string, data: { hookType?: HookType; label: string; command: string }) =>
    request<ProjectHook>(`/projects/${projectId}/hooks`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  updateHook: (
    projectId: string,
    hookType: HookType,
    index: number,
    data: {
      label?: string;
      command?: string;
      enabled?: boolean;
      hookType?: HookType;
    },
  ) =>
    request<{ ok: boolean }>(`/projects/${projectId}/hooks/${hookType}/${index}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  deleteHook: (projectId: string, hookType: HookType, index: number) =>
    request<{ ok: boolean }>(`/projects/${projectId}/hooks/${hookType}/${index}`, {
      method: 'DELETE',
    }),
  reorderHooks: (projectId: string, hookType: HookType, newOrder: number[]) =>
    request<{ ok: boolean }>(`/projects/${projectId}/hooks/reorder`, {
      method: 'PUT',
      body: JSON.stringify({ hookType, newOrder }),
    }),

  // Project Collaborators (project_members)
  listProjectMembers: (projectId: string) =>
    trpcCall(() => procedures.members.query({ projectId })),
  addProjectMember: (projectId: string, userId: string, role: ProjectMemberRole = 'member') =>
    trpcCall(() => procedures.addMember.mutate({ projectId, userId, role })),
  removeProjectMember: (projectId: string, userId: string) =>
    trpcCall(() => procedures.removeMember.mutate({ projectId, userId })),

  // User lookup (for adding collaborators)
  searchUsers: (q: string) =>
    request<UserSearchResult[]>(`/users/search?q=${encodeURIComponent(q)}`),
};

/** Project-assignable roles (unified-rbac-grants). `viewer` reads, `member`
 *  contributes, `admin` manages. `owner` is the creator and is not assignable. */
export type ProjectMemberRole = 'viewer' | 'member' | 'admin';

export interface UserSearchResult {
  id: string;
  username: string | null;
  name: string;
  email: string;
}
