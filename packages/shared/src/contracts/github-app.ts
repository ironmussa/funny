/**
 * The deployment's GitHub App for sandbox threads (sandbox-github-app-tokens),
 * admin only: inputs and answers of the `githubApp` tRPC procedures. GitHub's
 * manifest callback (`GET /api/settings/github-app/callback`) stays REST: the
 * admin's browser is redirected there by GitHub.
 */

import { z } from 'zod';

/** Start GitHub's App manifest flow under a personal account or an organization. */
export const startGithubAppManifestBody = z
  .object({
    /** A personal account (`user`) or an organization (`org`). */
    target: z.enum(['user', 'org']),
    org: z
      .string()
      .regex(/^[A-Za-z0-9-]{1,39}$/)
      .optional(),
  })
  .strict()
  .refine((v) => v.target === 'user' || !!v.org, { message: 'org is required' });

export type StartGithubAppManifestBody = z.output<typeof startGithubAppManifestBody>;

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

/** A GitHub account the admin can create the App under. */
export interface GithubAppAccount {
  login: string;
  type: 'user' | 'org';
}

export interface GithubAppAccounts {
  accounts: GithubAppAccount[];
  /** Whether the admin saved a GitHub token (Settings > Profile) to list them with. */
  hasToken: boolean;
}

/** Where the browser posts the manifest (`action`), and the single-use `state`. */
export interface GithubAppManifestStart {
  action: string;
  manifest: string;
  state: string;
}
