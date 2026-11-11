import { request } from './_core';

export interface GithubAppStatus {
  configured: boolean;
  source: 'environment' | 'database' | 'none';
  appId?: string;
  slug?: string | null;
  owner?: string | null;
  installUrl?: string | null;
  settingsUrl?: string | null;
  error?: string;
}

/** The deployment's GitHub App for sandbox threads (sandbox-github-app-tokens), admin only. */
export const githubAppApi = {
  getGithubAppStatus: () => request<GithubAppStatus>('/settings/github-app'),
  startGithubAppManifest: (data: { target: 'user' | 'org'; org?: string }) =>
    request<{ action: string; manifest: string; state: string }>('/settings/github-app/manifest', {
      method: 'POST',
      body: JSON.stringify(data),
    }),
  disconnectGithubApp: () => request<{ ok: boolean }>('/settings/github-app', { method: 'DELETE' }),
};
