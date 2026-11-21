import {
  deleteProjectSecretInput,
  listProjectSecretsInput,
  setProjectSecretInput,
} from '@funny/shared/contracts/project-secrets';

import { unwrap } from '../failure.js';
import { projectProcedure, router } from '../trpc.js';

const WRITE_FORBIDDEN = 'Keeping project secrets needs contributor access to the project';

// A project's secrets (openspec project-secrets). There is no procedure that
// returns a value: it goes in through `set` and reaches only the runner that
// starts a thread's agent. `steer` is enough for the caller's personal
// secrets; the port also demands `manage` for a shared one.
export const projectSecretsRouter = router({
  list: projectProcedure('view')
    .input(listProjectSecretsInput)
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.projectSecrets.list(ctx.userId, input.projectId)),
    ),
  set: projectProcedure('steer', WRITE_FORBIDDEN)
    .input(setProjectSecretInput)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.projectSecrets.set(ctx.userId, input)),
    ),
  delete: projectProcedure('steer', WRITE_FORBIDDEN)
    .input(deleteProjectSecretInput)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.projectSecrets.remove(ctx.userId, input.projectId, input.id)),
    ),
});
