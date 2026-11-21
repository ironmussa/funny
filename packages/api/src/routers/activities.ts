/** Background activities: the operations the caller started and their outcome. */

import { dismissActivityBody } from '@funny/shared/contracts/activities';

import { unwrap } from '../failure.js';
import { protectedProcedure, router } from '../trpc.js';

export const activitiesRouter = router({
  list: protectedProcedure.query(async ({ ctx }) =>
    unwrap(await ctx.ports.activities.list(ctx.userId)),
  ),
  /** Deletes one finished activity (or a running one whose runner is gone; 409 otherwise). */
  dismiss: protectedProcedure
    .input(dismissActivityBody)
    .mutation(async ({ ctx, input }) =>
      unwrap(await ctx.ports.activities.dismiss(ctx.userId, input.id)),
    ),
  clearFinished: protectedProcedure.mutation(async ({ ctx }) =>
    unwrap(await ctx.ports.activities.clearFinished(ctx.userId)),
  ),
});
