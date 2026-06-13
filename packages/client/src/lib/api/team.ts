import { request } from './_core';

export const teamApi = {
  getTeamSettings: () =>
    request<{
      id: string;
      name: string;
      slug: string;
      logo: string | null;
      hasApiKey: boolean;
      defaultModel: string | null;
      defaultMode: string | null;
      defaultPermissionMode: string | null;
    }>('/team-settings'),
  updateTeamApiKey: (apiKey: string | null) =>
    request<{ ok: boolean; hasApiKey: boolean }>('/team-settings/api-key', {
      method: 'PUT',
      body: JSON.stringify({ apiKey }),
    }),
  updateTeamDefaults: (data: {
    defaultModel?: string | null;
    defaultMode?: string | null;
    defaultPermissionMode?: string | null;
  }) =>
    request<{ ok: boolean }>('/team-settings/defaults', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  getSmtpSettings: () =>
    request<{
      host: string;
      port: string;
      user: string;
      from: string;
      hasPassword: boolean;
      source: 'database' | 'environment' | 'none';
      configured: boolean;
    }>('/settings/smtp'),
  updateSmtpSettings: (data: {
    host: string;
    port: string;
    user: string;
    pass?: string;
    from: string;
  }) =>
    request<{ ok: boolean }>('/settings/smtp', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),
  testSmtpSettings: () =>
    request<{ ok: boolean; sentTo: string }>('/settings/smtp/test', { method: 'POST' }),

  listTeamProjects: () => request<import('@funny/shared').Project[]>('/team-projects'),
  addTeamProject: (projectId: string) =>
    request<{ ok: boolean }>('/team-projects', {
      method: 'POST',
      body: JSON.stringify({ projectId }),
    }),
  removeTeamProject: (projectId: string) =>
    request<{ ok: boolean }>(`/team-projects/${projectId}`, { method: 'DELETE' }),

  // Invite Links
  listInviteLinks: () =>
    request<
      {
        id: string;
        token: string;
        role: string;
        expiresAt: string | null;
        maxUses: number | null;
        useCount: number;
        createdAt: string;
      }[]
    >('/invite-links'),
  createInviteLink: (data: { role?: string; expiresInDays?: number; maxUses?: number }) =>
    request<{
      id: string;
      token: string;
      role: string;
      expiresAt: string | null;
      maxUses: number | null;
      useCount: number;
      createdAt: string;
    }>('/invite-links', { method: 'POST', body: JSON.stringify(data) }),
  revokeInviteLink: (id: string) =>
    request<{ ok: boolean }>(`/invite-links/${id}`, { method: 'DELETE' }),
  acceptInviteLink: (token: string) =>
    request<{ ok: boolean; organizationId: string; alreadyMember?: boolean }>(
      '/invite-links/accept',
      { method: 'POST', body: JSON.stringify({ token }) },
    ),
  verifyInviteLink: (token: string) =>
    request<{
      valid: boolean;
      role: string;
      organizationName: string;
      organizationId: string;
    }>(`/invite-links/verify/${token}`),
  registerViaInvite: (data: {
    token: string;
    username: string;
    password: string;
    displayName?: string;
  }) =>
    request<{
      ok: boolean;
      user: { id: string; username: string; displayName: string };
      organizationId: string;
    }>('/invite-links/register', { method: 'POST', body: JSON.stringify(data) }),

  // Runners (tied to profile/team membership)
  getMyRunners: () =>
    request<{ runners: import('@funny/shared/runner-protocol').RunnerInfo[] }>('/runners'),
  deleteRunner: (runnerId: string) =>
    request<{ ok: boolean }>(`/runners/${runnerId}`, { method: 'DELETE' }),
  assignRunnerProject: (runnerId: string, projectId: string, localPath: string) =>
    request<import('@funny/shared/runner-protocol').RunnerProjectAssignment>(
      `/runners/${runnerId}/projects`,
      { method: 'POST', body: JSON.stringify({ projectId, localPath }) },
    ),
  unassignRunnerProject: (runnerId: string, projectId: string) =>
    request<{ ok: boolean }>(`/runners/${runnerId}/projects/${projectId}`, { method: 'DELETE' }),

  // Device-link runner enrollment
  getRunnerEnrollment: (userCode: string) =>
    request<import('@funny/shared/runner-protocol').EnrollmentInfo>(
      `/runners/enroll/${encodeURIComponent(userCode)}`,
    ),
  approveRunnerEnrollment: (userCode: string) =>
    request<{ ok: boolean; runnerId: string }>('/runners/enroll/approve', {
      method: 'POST',
      body: JSON.stringify({ userCode }),
    }),
};
