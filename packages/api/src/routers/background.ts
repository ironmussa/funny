/** Watchers and jobs: the background work of the caller's agents. */

import { jobListInput } from '@funny/shared/contracts/jobs';

import { unwrap } from '../failure.js';
import { protectedProcedure, router } from '../trpc.js';
import { idMutation } from './by-id.js';

export const watchersRouter = router({
  list: protectedProcedure.query(async ({ ctx }) =>
    unwrap(await ctx.ports.watchers.list(ctx.userId)),
  ),
  cancel: idMutation((ports, userId, id) => ports.watchers.cancel(userId, id)),
});

// Cancel and log reads stay REST: the runner owns the process and its logfile.
export const jobsRouter = router({
  // One page, newest first: a user's job history grows without bound.
  list: protectedProcedure
    .input(jobListInput)
    .query(async ({ ctx, input }) => unwrap(await ctx.ports.jobs.list(ctx.userId, input))),
});
