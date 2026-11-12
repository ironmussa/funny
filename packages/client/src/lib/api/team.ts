import type { SmtpSettingsRequest } from '@funny/shared/contracts/settings';

import { request } from './_core';
import { trpc, trpcCall } from './_trpc';

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
  getSmtpSettings: () => trpcCall(() => trpc.settings.getSmtp.query()),
  updateSmtpSettings: (data: SmtpSettingsRequest) =>
    trpcCall(() => trpc.settings.saveSmtp.mutate(data)),
  testSmtpSettings: () => trpcCall(() => trpc.settings.testSmtp.mutate()),

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
  getMyRunners: () => trpcCall(() => trpc.runners.list.query()),
  deleteRunner: (runnerId: string) => trpcCall(() => trpc.runners.remove.mutate({ runnerId })),
  assignRunnerProject: (runnerId: string, projectId: string, localPath: string) =>
    trpcCall(() => trpc.runners.assignProject.mutate({ runnerId, projectId, localPath })),
  unassignRunnerProject: (runnerId: string, projectId: string) =>
    trpcCall(() => trpc.runners.unassignProject.mutate({ runnerId, projectId })),

  // Device-link runner enrollment
  getRunnerEnrollment: (userCode: string) =>
    trpcCall(() => trpc.runners.enrollment.query({ userCode })),
  approveRunnerEnrollment: (userCode: string) =>
    trpcCall(() => trpc.runners.approveEnrollment.mutate({ userCode })),
};
