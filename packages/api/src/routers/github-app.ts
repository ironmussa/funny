import { startGithubAppManifestBody } from '@funny/shared/contracts/github-app';

import { unwrap } from '../failure.js';
import { adminProcedure, router } from '../trpc.js';

// Admin only. GitHub's manifest callback stays REST (the browser is sent there).
export const githubAppRouter = router({
  status: adminProcedure.query(async ({ ctx }) => unwrap(await ctx.ports.githubApp.status())),
  accounts: adminProcedure.query(async ({ ctx }) =>
    unwrap(await ctx.ports.githubApp.accounts(ctx.userId)),
  ),
  startManifest: adminProcedure
    .input(startGithubAppManifestBody)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.githubApp.startManifest(ctx.userId, input)),
    ),
  disconnect: adminProcedure.mutation(async ({ ctx }) =>
    unwrap(await ctx.ports.githubApp.disconnect()),
  ),
});
