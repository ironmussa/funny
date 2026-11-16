import { factoryProjectInput, saveFactorySettingsInput } from '@funny/shared/contracts/factory';

import { unwrap } from '../failure.js';
import { projectProcedure, router } from '../trpc.js';

const SAVE_FORBIDDEN = 'Running an issue factory needs contributor access to the project';

// The caller's own issue factory for a project (change issue-factory). Saving
// needs `steer`, the capability of starting threads: the factory starts them
// in the caller's name.
export const factoryRouter = router({
  settings: projectProcedure('view')
    .input(factoryProjectInput)
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.settings(ctx.userId, input.projectId)),
    ),
  save: projectProcedure('steer', SAVE_FORBIDDEN)
    .input(saveFactorySettingsInput)
    .mutation(async ({ ctx, input: { projectId, ...data } }) =>
      unwrap(await ctx.ports.factory.save(ctx.userId, projectId, data)),
    ),
  runs: projectProcedure('view')
    .input(factoryProjectInput)
    .query(async ({ ctx, input }) =>
      unwrap(await ctx.ports.factory.runs(ctx.userId, input.projectId)),
    ),
});
