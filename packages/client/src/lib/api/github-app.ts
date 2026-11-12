import type { StartGithubAppManifestBody } from '@funny/shared/contracts/github-app';

import { trpc, trpcCall } from './_trpc';

export type { GithubAppAccount, GithubAppStatus } from '@funny/shared/contracts/github-app';

const procedures = trpc.githubApp;

/** The deployment's GitHub App for sandbox threads (sandbox-github-app-tokens), admin only. */
export const githubAppApi = {
  getGithubAppStatus: () => trpcCall(() => procedures.status.query()),
  getGithubAppAccounts: () => trpcCall(() => procedures.accounts.query()),
  startGithubAppManifest: (data: StartGithubAppManifestBody) =>
    trpcCall(() => procedures.startManifest.mutate(data)),
  disconnectGithubApp: () => trpcCall(() => procedures.disconnect.mutate()),
};
